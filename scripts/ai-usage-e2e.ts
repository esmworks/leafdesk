/**
 * End-to-end check of AI usage and the monthly cost limit against the database, with two fake
 * OpenAI-compatible servers reached over HTTP (src/server/ai/fake-openai.ts): one for the server's
 * own AI settings, one for a workspace's own AI account. Answers on either key land in `ai_usage`
 * under their workspace, month, feature, model and payer; only owners set the limit (audited) and
 * see the usage; the owners' limit stops requests before they reach the provider; the server's
 * AI_MONTHLY_LIMIT_USD stops only what its own key would pay; old months are pruned.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-usage-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const fakeModule = await import("@/server/ai/fake-openai");
const serverFake = await fakeModule.startFakeOpenAi(() => ({ text: "from the server's AI" }));
const ownFake = await fakeModule.startFakeOpenAi(() => ({ text: "from my own key" }));

process.env.OWN_AI_KEYS_ENABLED = "true";
delete process.env.AI_ONLY_OWN_KEYS;
delete process.env.AI_MONTHLY_LIMIT_USD;
process.env.AI_ALLOWED_HOSTS = new URL(ownFake.baseUrl).host;
process.env.WORKSPACE_CREATION = "everyone";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiUsage, auditEvent, user, workspace, workspaceMember } = await import("@/db/schema");
const { createWorkspace, updateWorkspaceSettings, getWorkspaceSettings } = await import("@/server/workspaces");
const accounts = await import("@/server/ai-accounts");
const ai = await import("@/server/ai");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { databaseAiUsage, pruneAiUsage } = await import("@/server/ai/usage-store");
const { workspaceAiUsage } = await import("@/server/ai-usage");

const RUN = `aiusage-e2e-${Date.now().toString(36)}`;

setAiEnv(
  {
    AI_PROVIDER: "openai-compatible",
    AI_MODEL: "server-model",
    AI_BASE_URL: serverFake.baseUrl,
    AI_API_KEY: "server-key",
    AI_RATE_LIMIT: "1000",
    AI_WORKSPACE_RATE_LIMIT: "1000",
  },
  { usage: databaseAiUsage },
);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function fails(fn: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as { code?: string; message: string };
  }
}

const ask = (workspaceId: string, feature = "chat") => ai.complete({ feature, workspaceId, messages: [{ role: "user", content: "hi" }] });
const rowsOf = (workspaceId: string) => db.select().from(aiUsage).where(eq(aiUsage.workspaceId, workspaceId));
const now = new Date();
const spend = (workspaceId: string, costUsd: number, ownAccount = false, at = now) =>
  databaseAiUsage.record(
    { workspaceId, feature: "seeded", model: "seeded-model", ownAccount, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd },
    at,
  );

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceIds: string[] = [];

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));

  // ── Recording ───────────────────────────────────────────────────────────────────────────────
  const onServer = (await createWorkspace(ids.owner, `${RUN} server`)).id;
  workspaceIds.push(onServer);
  await db.insert(workspaceMember).values({ workspaceId: onServer, userId: ids.member, role: "member" });
  check((await ask(onServer)).text === "from the server's AI", "a workspace without an account of its own runs on the server's key");
  await ask(onServer);
  await ask(onServer, "editor.improve");
  const recorded = await rowsOf(onServer);
  const chat = recorded.find((r) => r.feature === "chat");
  check(
    chat && chat.requests === 2 && chat.model === "server-model" && !chat.ownAccount && chat.inputTokens === 20 && chat.outputTokens === 10,
    "its answers are counted under it, by feature and model, with their tokens",
    recorded,
  );
  check(recorded.some((r) => r.feature === "editor.improve" && r.requests === 1), "…each feature on its own line");
  check(chat.month === `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`, "…in this month (UTC)");

  ownFake.setAcceptedKeys(["sk-own-usage-0001"]);
  const [account] = await accounts.addAiAccount(ids.owner, {
    provider: "openai-compatible",
    model: "own-model",
    baseUrl: ownFake.baseUrl,
    apiKey: "sk-own-usage-0001",
  });
  const onOwn = (await createWorkspace(ids.owner, `${RUN} own`)).id;
  workspaceIds.push(onOwn);
  await accounts.setWorkspaceAiAccount(ids.owner, onOwn, account.id);
  check((await ask(onOwn)).text === "from my own key", "a workspace with its own AI account runs on it");
  const own = (await rowsOf(onOwn)).find((r) => r.feature === "chat");
  check(own?.ownAccount === true && own.model === "own-model" && own.requests === 1, "…and its answers count under that workspace, as its own account's", own);

  // ── Who sets the limit ──────────────────────────────────────────────────────────────────────
  const notOwner = await fails(() => updateWorkspaceSettings(ids.member, onServer, { aiMonthlyLimitUsd: 100 }));
  check(notOwner !== null, "a member can't set the monthly limit");
  for (const bad of [0, -1, "ten", 5_000_000]) {
    const error = await fails(() => updateWorkspaceSettings(ids.owner, onServer, { aiMonthlyLimitUsd: bad as number }));
    check(error?.code === "invalidSetting", `a limit of ${JSON.stringify(bad)} is refused`);
  }
  await updateWorkspaceSettings(ids.owner, onServer, { aiMonthlyLimitUsd: 5 });
  check((await getWorkspaceSettings(ids.owner, onServer)).aiMonthlyLimitUsd === 5, "an owner sets it");
  const audited = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, onServer), eq(auditEvent.action, "workspace.settings_changed")));
  check(audited.some((e) => JSON.stringify(e.details).includes("aiMonthlyLimitUsd")), "…and the audit log says so");

  // ── The owners' limit ───────────────────────────────────────────────────────────────────────
  await spend(onServer, 4.99);
  await ask(onServer);
  const chatsBefore = serverFake.chats.length;
  await spend(onServer, 0.01);
  const refused = await fails(() => ask(onServer));
  check(refused?.code === "limitReached", "once the month reaches the limit, requests are refused", refused);
  check(serverFake.chats.length === chatsBefore, "…before anything is sent to the provider");
  check((await ask(onOwn)).text === "from my own key", "…while other workspaces go on");

  const report = await workspaceAiUsage(ids.owner, onServer);
  check(report.reached === "workspace" && report.limit.workspace === 5 && Math.abs(report.spent.totalUsd - 5) < 1e-9, "the owners' view says the limit is reached", report);
  check(
    report.months[0].byGroup.some((g) => g.group === "chat" && g.requests === 3) && report.months[0].byModel.some((m) => m.model === "server-model"),
    "…and breaks the month down by feature and model",
    report.months[0],
  );
  check((await fails(() => workspaceAiUsage(ids.member, onServer))) !== null, "members don't see the usage");

  await updateWorkspaceSettings(ids.owner, onServer, { aiMonthlyLimitUsd: null });
  check((await ask(onServer)).text === "from the server's AI", "clearing the limit lets requests through again");

  // ── The server's limit ──────────────────────────────────────────────────────────────────────
  process.env.AI_MONTHLY_LIMIT_USD = "3";
  await spend(onOwn, 50, true);
  check((await ask(onOwn)).text === "from my own key", "the server's limit doesn't count what a workspace's own account paid");
  const serverRefused = await fails(() => ask(onServer));
  check(serverRefused?.code === "limitReached", "…but stops a workspace whose server-paid month reached it", serverRefused);
  await spend(onOwn, 3, false);
  check((await ask(onOwn)).text === "from my own key", "…and never holds requests the workspace's own account pays");
  const ownReport = await workspaceAiUsage(ids.owner, onOwn);
  check(ownReport.ownAccount && ownReport.reached === null && ownReport.months[0].ownAccountCostUsd >= 50, "the own account's workspace sees what its account paid", ownReport);
  delete process.env.AI_MONTHLY_LIMIT_USD;

  // ── Old months ──────────────────────────────────────────────────────────────────────────────
  await spend(onServer, 1, false, new Date(Date.UTC(now.getUTCFullYear() - 2, 0, 15)));
  await spend(onServer, 1, false, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 15)));
  await pruneAiUsage(now);
  const months = new Set((await rowsOf(onServer)).map((r) => r.month));
  check(months.size === 2, "the daily cleanup forgets months older than twelve, keeping the last twelve", [...months]);

  console.log(`\n${passed} checks passed`);
} finally {
  delete process.env.AI_MONTHLY_LIMIT_USD;
  resetAi();
  if (workspaceIds.length) await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, userIds));
  await serverFake.close();
  await ownFake.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

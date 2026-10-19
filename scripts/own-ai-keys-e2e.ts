/**
 * End-to-end check of people's own AI accounts (OWN_AI_KEYS_ENABLED) against the database, with two
 * fake OpenAI-compatible servers reached over HTTP (src/server/ai/fake-openai.ts): one for the
 * server's own AI settings, one for a person's account. Adding an account (tried first; a wrong key
 * or a private address is refused, the key never shown again), one person's key serving two of their
 * workspaces, a new workspace taking their default account, who may attach an account, the semantic
 * search index made again with the account's embeddings model (that workspace only), a refused key
 * marking the account broken, the payer leaving (the workspace falls back to the server's AI and its
 * owners are told), AI_ONLY_OWN_KEYS (no account: no AI), removing an account, and the flag off
 * (exactly as before: the server's settings, nothing to add).
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/own-ai-keys-e2e.ts
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
// The person's fake runs on this machine: a private address the guarded fetch refuses unless allowed.
process.env.AI_ALLOWED_HOSTS = new URL(ownFake.baseUrl).host;
process.env.WORKSPACE_CREATION = "everyone";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiAccount, notification, pageChunk, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createWorkspace, removeMember } = await import("@/server/workspaces");
const accounts = await import("@/server/ai-accounts");
const ai = await import("@/server/ai");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const index = await import("@/server/semantic-index");

const RUN = `ownai-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);

const SERVER_AI = {
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "server-model",
  AI_BASE_URL: serverFake.baseUrl,
  AI_API_KEY: "server-key",
  AI_RATE_LIMIT: "1000",
  AI_WORKSPACE_RATE_LIMIT: "1000",
};
setAiEnv(SERVER_AI);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (index.indexBusy()) {
    if (Date.now() > until) throw new Error("The index did not settle in time");
    await sleep(100);
  }
  await index.whenIndexIdle();
}

const ask = (workspaceId: string) => ai.complete({ feature: "own-ai-keys-e2e", workspaceId, messages: [{ role: "user", content: "hi" }] });
const OWN_KEY = "sk-own-test-key-0001";
const own = (extra: Partial<Parameters<typeof accounts.addAiAccount>[1]> = {}) => ({
  provider: "openai-compatible" as const,
  model: "own-model",
  baseUrl: ownFake.baseUrl,
  apiKey: OWN_KEY,
  ...extra,
});

const ids = { payer: `${RUN}-payer`, coOwner: `${RUN}-coowner`, member: `${RUN}-member`, other: `${RUN}-other` };
const userIds = Object.values(ids);
const workspaceIds: string[] = [];
const modelsIn = async (workspaceId: string) =>
  (await db.selectDistinct({ model: pageChunk.model }).from(pageChunk).where(eq(pageChunk.workspaceId, workspaceId))).map((r) => r.model);
const accountOf = async (workspaceId: string) => (await db.select({ id: workspace.aiAccountId }).from(workspace).where(eq(workspace.id, workspaceId)))[0]?.id ?? null;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));

  // ── Adding an account ───────────────────────────────────────────────────────────────────────
  for (const address of ["http://127.0.0.1:9/v1", "https://localhost/v1", "https://10.1.2.3/v1", "https://169.254.169.254/v1", "http://models.example.com/v1"]) {
    const error = await fails(() => accounts.addAiAccount(ids.payer, own({ baseUrl: address })));
    check(error?.code === "baseUrlInvalid", `a private or plain-http address is refused (${address})`, error?.message);
  }
  for (const provider of ["ollama", "lmstudio"]) {
    const error = await fails(() => accounts.addAiAccount(ids.payer, { ...own(), provider: provider as "openai" }));
    check(error?.code === "providerRequired", `a local provider is refused (${provider})`);
  }
  ownFake.setAcceptedKeys([OWN_KEY]);
  const wrong = await fails(() => accounts.addAiAccount(ids.payer, own({ apiKey: "sk-wrong-key-9999" })));
  check(wrong?.code === "testFailed", "a key the provider refuses is not saved", wrong?.message);
  check(!JSON.stringify(wrong).includes("sk-wrong-key-9999"), "…and the error doesn't repeat the key");
  check((await db.select().from(aiAccount).where(eq(aiAccount.userId, ids.payer))).length === 0, "…nothing was stored");

  const before = ownFake.chats.length;
  const [first] = await accounts.addAiAccount(ids.payer, own({ label: "My key", embeddingsModel: "own-embed" }));
  check(ownFake.chats.length === before + 1 && ownFake.embedded.length > 0, "adding an account tries chat and embeddings first");
  check(first.isDefault && first.label === "My key" && first.keyHint === "0001", "the first account is the default, with the key's last characters", first);
  const listed = JSON.stringify(await accounts.listAiAccounts(ids.payer));
  check(!listed.includes(OWN_KEY), "the key is never shown again");
  const [stored] = await db.select({ apiKey: aiAccount.apiKey }).from(aiAccount).where(eq(aiAccount.id, first.id));
  check(stored.apiKey && !stored.apiKey.includes(OWN_KEY), "…and is stored sealed");
  const otherAccount = (await accounts.addAiAccount(ids.other, own({ label: "Someone else's" }))).at(-1)!;

  // ── One key, two workspaces ─────────────────────────────────────────────────────────────────
  const ws1 = (await createWorkspace(ids.payer, `${RUN} one`)).id;
  const ws2 = (await createWorkspace(ids.payer, `${RUN} two`)).id;
  workspaceIds.push(ws1, ws2);
  check((await accountOf(ws1)) === first.id && (await accountOf(ws2)) === first.id, "a new workspace runs on its creator's default account");
  const keysBefore = ownFake.keys.length;
  check((await ask(ws1)).text === "from my own key", "the first workspace's AI answers on the person's key");
  check((await ask(ws2)).text === "from my own key", "…and so does the second's");
  check(ownFake.keys.slice(keysBefore).every((k) => k === OWN_KEY) && ownFake.keys.length === keysBefore + 2, "…both with that one key");
  check((await ai.aiInfoFor(ws1))?.accountId === first.id, "the workspace's AI says which account it runs on");
  const serverKeys = serverFake.keys.length;
  const ws3 = (await createWorkspace(ids.other, `${RUN} three`)).id;
  workspaceIds.push(ws3);
  check((await accountOf(ws3)) === otherAccount.id, "another person's workspace runs on their own default account");
  await accounts.setWorkspaceAiAccount(ids.other, ws3, null);
  check((await ask(ws3)).text === "from the server's AI" && serverFake.keys.at(-1) === "server-key", "a workspace without an account runs on the server's AI");
  check(serverFake.keys.length === serverKeys + 1, "…and only that one reached the server's AI");

  // ── Who may attach an account ───────────────────────────────────────────────────────────────
  await db.insert(workspaceMember).values([
    { workspaceId: ws1, userId: ids.coOwner, role: "owner" },
    { workspaceId: ws1, userId: ids.member, role: "member" },
    { workspaceId: ws1, userId: ids.other, role: "owner" },
  ]);
  check((await fails(() => accounts.setWorkspaceAiAccount(ids.member, ws1, null))) !== null, "a member can't change the workspace's account");
  const notTheirs = await fails(() => accounts.setWorkspaceAiAccount(ids.coOwner, ws1, first.id));
  check(notTheirs?.code === "notFound", "an owner can't attach someone else's account");
  const view = await accounts.workspaceAiView(ids.coOwner, ws1);
  check(view?.source.kind === "account" && !view.source.mine && view.source.ownerName === ids.payer && view.canChange, "co-owners see whose account pays", view);
  const memberView = await accounts.workspaceAiView(ids.member, ws1);
  check(memberView?.canChange === false && memberView.mine.length === 0, "members see it without choices");

  // ── Embeddings per workspace ────────────────────────────────────────────────────────────────
  const general2 = (await db.execute<{ id: string }>(sql`select id from teamspace where workspace_id = ${ws2} limit 1`))[0].id;
  const general3 = (await db.execute<{ id: string }>(sql`select id from teamspace where workspace_id = ${ws3} limit 1`))[0].id;
  await createPage({ userId: ids.payer }, { workspaceId: ws2, teamspaceId: general2, title: "Fleet notes", markdown: "Our car needs new tyres." });
  await createPage({ userId: ids.other }, { workspaceId: ws3, teamspaceId: general3, title: "Other notes", markdown: "Nothing to embed here." });
  await settle();
  check(JSON.stringify(await modelsIn(ws2)) === JSON.stringify(["own-embed"]), "pages are indexed with the account's embeddings model", await modelsIn(ws2));
  check((await modelsIn(ws3)).length === 0, "…not in a workspace whose AI has no embeddings model");
  check((await ai.embeddingModelFor(ws2)) === "own-embed" && (await ai.embeddingModelFor(ws3)) === null, "the embeddings model is per workspace");
  await accounts.updateAiAccount(ids.payer, first.id, own({ label: "My key", apiKey: null, embeddingsModel: "own-embed-2" }));
  check(ownFake.keys.at(-1) === OWN_KEY, "changing an account without a new key keeps the saved one");
  await settle();
  check(JSON.stringify(await modelsIn(ws2)) === JSON.stringify(["own-embed-2"]), "a new embeddings model indexes the account's workspaces again", await modelsIn(ws2));

  // ── A refused key ───────────────────────────────────────────────────────────────────────────
  ownFake.setAcceptedKeys(["sk-rotated-key-0002"]);
  check((await fails(() => ask(ws2)))?.code === "provider", "a request with a key the provider refuses fails");
  await sleep(200);
  check((await accounts.listAiAccounts(ids.payer))[0].status === "broken", "…and marks the account broken for its owner");
  ownFake.setAcceptedKeys(null);
  check((await accounts.testAiAccount(ids.payer, first.id))[0].status === "active", "testing it again once it works marks it working");

  // ── The payer leaves ────────────────────────────────────────────────────────────────────────
  await removeMember(ids.payer, ws1, ids.payer);
  check((await accountOf(ws1)) === null, "when the account's owner leaves, the workspace stops using their account");
  const told = await db
    .select({ userId: notification.userId })
    .from(notification)
    .where(and(eq(notification.workspaceId, ws1), eq(notification.kind, "ai_account_detached")));
  check(JSON.stringify(told.map((n) => n.userId).sort()) === JSON.stringify([ids.coOwner, ids.other].sort()), "…its other owners are told, members aren't", told);
  check((await ask(ws1)).text === "from the server's AI", "…and its AI falls back to the server's");
  check((await ask(ws2)).text === "from my own key", "the payer's other workspace keeps their account");
  // A guest isn't a payer either.
  await accounts.setWorkspaceAiAccount(ids.other, ws1, otherAccount.id);
  await db.update(workspaceMember).set({ role: "guest" }).where(and(eq(workspaceMember.workspaceId, ws1), eq(workspaceMember.userId, ids.other)));
  check((await ai.aiTargetFor(ws1))?.accountId == null, "an account whose owner is only a guest doesn't pay");
  await db.update(workspaceMember).set({ role: "owner" }).where(and(eq(workspaceMember.workspaceId, ws1), eq(workspaceMember.userId, ids.other)));
  await accounts.setWorkspaceAiAccount(ids.other, ws1, null);

  // ── Only own keys ───────────────────────────────────────────────────────────────────────────
  process.env.AI_ONLY_OWN_KEYS = "true";
  check((await ai.aiEnabledFor(ws1)) === false, "with only own keys, a workspace without an account has no AI");
  const serverBefore = serverFake.keys.length;
  check((await fails(() => ask(ws1)))?.code === "disabled", "…a request is refused");
  check(serverFake.keys.length === serverBefore, "…and the server's key is never sent");
  check((await accounts.workspaceAiView(ids.coOwner, ws1))?.source.kind === "off", "…its settings say AI is off");
  check((await ask(ws2)).text === "from my own key", "a workspace with an account still works");
  delete process.env.AI_ONLY_OWN_KEYS;

  // ── The flag off ────────────────────────────────────────────────────────────────────────────
  process.env.OWN_AI_KEYS_ENABLED = "";
  check((await ai.aiTargetFor(ws2))?.accountId === null, "with own keys off, every workspace runs on the server's settings");
  check((await ask(ws2)).text === "from the server's AI", "…even one that has an account");
  check((await fails(() => accounts.addAiAccount(ids.payer, own())))?.code === "disabled", "…and no account can be added");
  check((await accounts.workspaceAiView(ids.payer, ws2)) === null, "…nor is there anything to show");
  process.env.OWN_AI_KEYS_ENABLED = "true";

  // ── Removing the account ────────────────────────────────────────────────────────────────────
  await db.insert(workspaceMember).values({ workspaceId: ws2, userId: ids.coOwner, role: "owner" });
  await accounts.deleteAiAccount(ids.payer, first.id);
  check((await accountOf(ws2)) === null, "removing an account takes it off its workspaces");
  const toldAgain = await db.select({ userId: notification.userId }).from(notification).where(and(eq(notification.workspaceId, ws2), eq(notification.kind, "ai_account_detached")));
  check(toldAgain.length === 1 && toldAgain[0].userId === ids.coOwner, "…and tells their other owners", toldAgain);
  check((await ask(ws2)).text === "from the server's AI", "…which fall back to the server's AI");
  await settle();
  check((await modelsIn(ws2)).length === 0, "…and drop the account's embeddings when the server has none");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await settle().catch(() => {});
  if (workspaceIds.length) await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, userIds));
  await serverFake.close();
  await ownFake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

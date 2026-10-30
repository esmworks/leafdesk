/**
 * End-to-end check of agents' guardrails against the database: who may create agents when owners
 * choose people and groups (agent_creator); the notices near and at an agent's monthly limit and the
 * workspace's cost limit, to owners and the agent's creator, once a month (ai_limit); a new agent
 * spending fast turned off mid-run; and asking for a higher limit (agent_limit_request), answered
 * from the owners' inbox. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-guardrails-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentLimitRequest, agentRun, auditEvent, notification, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createGroup } = await import("@/server/groups");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { listNotifications } = await import("@/server/notifications");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
const agents = await import("@/server/agents/manage");
const sharing = await import("@/server/agents/sharing");
const limits = await import("@/server/agents/limits");
const versions = await import("@/server/agents/versions");
const notices = await import("@/server/ai-limit-notices");
const { requestAgentRun } = await import("@/server/agents/requests");
const { flushAgentRuns } = await import("@/server/agents/run");

const RUN = `agent-guardrails-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
// Each turn of the fake model counts 15 tokens.
const fake = await startFakeOpenAi();
setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });

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

/** The error's code when the promise fails (`access` for an AccessError), null when it doesn't. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof agents.AgentError) return error.code === "invalid" ? `invalid:${String(error.params.reason)}` : error.code;
    if (error instanceof AccessError) return "access";
    return `other: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const ids = {
  owner: `${RUN}-owner`,
  coOwner: `${RUN}-coowner`,
  maker: `${RUN}-maker`,
  grouped: `${RUN}-grouped`,
  other: `${RUN}-other`,
  guest: `${RUN}-guest`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** The AI limit notices a person has in the workspace, as their inbox lists them. */
const limitItems = async (userId: string) =>
  (await listNotifications(userId, { workspaceId, kinds: ["ai_limit", "agent_limit_request"] })).map((n) => ({
    kind: n.kind,
    notice: n.aiLimit?.notice ?? null,
    agent: n.aiLimit?.agent?.name ?? n.limitRequest?.agentName ?? null,
    request: n.limitRequest,
    read: n.read,
  }));

/** Waits for work started without waiting (the workspace's notices). */
async function until(condition: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 50; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.coOwner, name: "Owner Orhan", email: `${ids.coOwner}@example.test` },
    { id: ids.maker, name: "Maker Melis", email: `${ids.maker}@example.test` },
    { id: ids.grouped, name: "Grouped Gizem", email: `${ids.grouped}@example.test` },
    { id: ids.other, name: "Other Onur", email: `${ids.other}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.coOwner, role: "owner" },
    { workspaceId, userId: ids.maker, role: "member" },
    { workspaceId, userId: ids.grouped, role: "member" },
    { workspaceId, userId: ids.other, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);

  // ── Who creates agents: the people and groups owners choose ────────────────────────────────
  await updateWorkspaceSettings(ids.owner, workspaceId, { agentCreation: "chosen" });
  check(!(await sharing.canCreateAgents(ids.maker, workspaceId)), "chosen, with nobody chosen: members don't create agents");
  check(await sharing.canCreateAgents(ids.owner, workspaceId), "…owners always do");
  const group = await createGroup(ids.owner, workspaceId, "Builders", [ids.grouped]);
  await sharing.addAgentCreator(ids.owner, workspaceId, { kind: "person", userId: ids.maker });
  const view = await sharing.addAgentCreator(ids.owner, workspaceId, { kind: "group", groupId: group.id });
  check(
    view.entries.length === 2 && view.members.every((m) => m.userId !== ids.owner && m.userId !== ids.guest) && view.groups.some((g) => g.groupId === group.id),
    "owners add a member and a group; members offered are neither owners nor guests",
    view,
  );
  check(await sharing.canCreateAgents(ids.maker, workspaceId), "a chosen member creates agents");
  check(await sharing.canCreateAgents(ids.grouped, workspaceId), "…and so does a member of a chosen group");
  check(!(await sharing.canCreateAgents(ids.other, workspaceId)), "…while a member who is neither doesn't");
  check(!(await sharing.canCreateAgents(ids.guest, workspaceId)), "…nor a guest");
  check((await refusal(sharing.addAgentCreator(ids.owner, workspaceId, { kind: "person", userId: ids.guest }))) === "notAMember", "guests can't be chosen");
  check((await refusal(sharing.addAgentCreator(ids.maker, workspaceId, { kind: "person", userId: ids.other }))) === "access", "only owners choose");
  check((await refusal(agents.createAgent(ids.other, workspaceId, { name: "Not mine" }))) === "access", "creating one unchosen is refused");
  await sharing.removeAgentCreator(ids.owner, workspaceId, { kind: "group", groupId: group.id });
  check(!(await sharing.canCreateAgents(ids.grouped, workspaceId)), "taking the group off takes the right away");
  const creatorEvents = await db
    .select({ action: auditEvent.action, details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), inArray(auditEvent.action, ["agent.creator_added", "agent.creator_removed"])));
  check(
    creatorEvents.filter((e) => e.action === "agent.creator_added").length === 2 && creatorEvents.filter((e) => e.action === "agent.creator_removed").length === 1,
    "adding and removing are in the audit log",
    creatorEvents,
  );

  // ── Notices near and at an agent's limit ────────────────────────────────────────────────────
  const helper = await agents.createAgent(ids.maker, workspaceId, { name: "Helper", instructions: "Answer briefly." });
  check(helper.access === "full", "the chosen member's agent is theirs at full access");
  await agents.updateAgent(ids.owner, helper.id, { monthlyTokenLimit: 1000 });
  // Older than a day: not new any more, so spending is only measured against its limit.
  await db.execute(sql`update workspace_agent set created_at = now() - interval '3 days' where id = ${helper.id}`);
  const agentRow = async (id: string) => (await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, id)))[0];
  check((await notices.noticeAgentSpending(await agentRow(helper.id), 700)) === null && (await limitItems(ids.owner)).length === 0, "below 80% nobody hears");
  await notices.noticeAgentSpending(await agentRow(helper.id), 850);
  const nearOwner = await limitItems(ids.owner);
  const nearMaker = await limitItems(ids.maker);
  check(nearOwner.length === 1 && nearOwner[0].notice === "near" && nearOwner[0].agent === "Helper", "past 80%, an owner hears it's near", nearOwner);
  check((await limitItems(ids.coOwner)).length === 1, "…every owner does");
  check(nearMaker.length === 1 && nearMaker[0].notice === "near", "…and so does the member who made it", nearMaker);
  check((await limitItems(ids.other)).length === 0, "…but not other members");
  notices.forgetAiLimitNotices();
  await notices.noticeAgentSpending(await agentRow(helper.id), 900);
  check((await limitItems(ids.owner)).length === 1, "once a month: past 80% again, nothing new (even after a restart)");
  await notices.noticeAgentSpending(await agentRow(helper.id), 1000);
  const reached = await limitItems(ids.owner);
  check(reached.length === 2 && reached.some((n) => n.notice === "reached"), "at the limit, owners hear it was reached", reached);
  check((await agentRow(helper.id)).enabled, "an agent older than a day isn't turned off for it");

  // ── The workspace's cost limit ─────────────────────────────────────────────────────────────
  notices.noticeWorkspaceSpending(workspaceId, 8.5, 10);
  await until(async () => (await limitItems(ids.owner)).some((n) => n.agent === null), "the workspace's notice");
  const workspaceNear = (await limitItems(ids.owner)).filter((n) => n.agent === null);
  check(workspaceNear.length === 1 && workspaceNear[0].notice === "near", "past 80% of the workspace's cost limit, owners hear it", workspaceNear);
  check((await limitItems(ids.maker)).every((n) => n.agent !== null), "…members don't");

  // ── A new agent spending fast is turned off mid-run ───────────────────────────────────────
  const eager = await agents.createAgent(ids.maker, workspaceId, { name: "Eager", instructions: "Do the task." });
  await agents.updateAgent(ids.owner, eager.id, { monthlyTokenLimit: 40 });
  const asked = await requestAgentRun(ids.maker, eager.id, { task: "Summarize the week.", via: "mcp" });
  await flushAgentRuns();
  const [run] = await db.select().from(agentRun).where(eq(agentRun.id, asked.id));
  const eagerNow = await agentRow(eager.id);
  check(run?.status === "failed" && run.code === "agentDisabled", "its first turn went past a quarter of its limit: the run stops", run);
  check(!eagerNow.enabled, "…and the agent is turned off");
  const paused = (await limitItems(ids.maker)).filter((n) => n.agent === "Eager");
  check(paused.length === 1 && paused[0].notice === "paused", "its creator hears why", paused);
  check((await limitItems(ids.owner)).some((n) => n.agent === "Eager" && n.notice === "paused"), "…and so do owners");
  const [pauseEvent] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "agent.updated"), sql`${auditEvent.details}->>'reason' = 'spendingFast'`));
  check(pauseEvent && pauseEvent.actorUserId === null, "the audit log records the system turning it off", pauseEvent);
  const eagerVersions = await versions.listAgentVersions(ids.owner, eager.id);
  check(eagerVersions.length > 0, "…and the agent's history keeps the change");
  await agents.updateAgent(ids.maker, eager.id, { enabled: true });
  notices.forgetAiLimitNotices();
  check((await notices.noticeAgentSpending(await agentRow(eager.id), 30)) === null && (await agentRow(eager.id)).enabled, "turned back on, it isn't turned off again this month");

  // ── Asking for a higher limit ─────────────────────────────────────────────────────────────
  check((await refusal(limits.requestHigherLimit(ids.owner, helper.id, 5000, ""))) === "notAllowed", "owners change the limit themselves");
  check((await refusal(limits.requestHigherLimit(ids.other, helper.id, 5000, ""))) === "notAllowed", "view & interact can't ask");
  check((await refusal(limits.requestHigherLimit(ids.maker, helper.id, 1000, ""))) === "invalid:requestTokens", "the number must be above the limit");
  check((await refusal(limits.requestHigherLimit(ids.maker, helper.id, 5000, "x".repeat(501)))) === "invalid:requestNote", "the reason is short");
  const unlimited = await agents.createAgent(ids.maker, workspaceId, { name: "Unlimited" });
  check((await refusal(limits.requestHigherLimit(ids.maker, unlimited.id, 5000, ""))) === "invalid:noLimit", "an agent without a limit has none to raise");

  const first = await limits.requestHigherLimit(ids.maker, helper.id, 5000, "Month-end reports");
  check((await limits.pendingLimitRequest(ids.maker, helper.id))?.id === first.id, "the request waits, and the asker sees it");
  const ownerInbox = (await limitItems(ids.owner)).filter((n) => n.kind === "agent_limit_request");
  check(
    ownerInbox.length === 1 && ownerInbox[0].request?.tokens === 5000 && ownerInbox[0].request.current === 1000 && ownerInbox[0].request.note === "Month-end reports",
    "owners have it in their inbox, with the number, the limit now and the reason",
    ownerInbox,
  );
  check((await limitItems(ids.maker)).every((n) => n.kind !== "agent_limit_request"), "…the member who asked doesn't");
  await db.update(notification).set({ readAt: new Date() }).where(eq(notification.agentLimitRequestId, first.id));
  const again = await limits.requestHigherLimit(ids.maker, helper.id, 8000, "Month-end and audits");
  const changed = (await limitItems(ids.owner)).filter((n) => n.kind === "agent_limit_request");
  check(again.id === first.id && changed.length === 1 && changed[0].request?.tokens === 8000 && !changed[0].read, "asking again changes the request, unread again", changed);

  check((await refusal(limits.decideLimitRequest(ids.maker, workspaceId, first.id, true))) === "access", "only owners answer");
  await limits.decideLimitRequest(ids.coOwner, workspaceId, first.id, false);
  check((await limitItems(ids.owner)).every((n) => n.kind !== "agent_limit_request"), "once declined, it leaves every owner's inbox");
  check((await agentRow(helper.id)).monthlyTokenLimit === 1000, "…the limit stays");
  check((await limitItems(ids.maker)).some((n) => n.agent === "Helper" && n.notice === "declined"), "…and the asker hears so");
  check((await refusal(limits.decideLimitRequest(ids.owner, workspaceId, first.id, true))) === "requestNotFound", "an answered request can't be answered again");

  const second = await limits.requestHigherLimit(ids.maker, helper.id, 6000, "");
  check(second.id !== first.id, "a new request after an answer is a new one");
  await limits.decideLimitRequest(ids.owner, workspaceId, second.id, true);
  check((await agentRow(helper.id)).monthlyTokenLimit === 6000, "approving raises the limit to the number asked");
  // The owner's changes close together make one version: its setup has the new limit.
  const [newest] = await db.execute<{ limit: unknown }>(
    sql`select snapshot->'settings'->'monthly_token_limit' as limit from agent_version where agent_id = ${helper.id} order by number desc limit 1`,
  );
  check(Number(newest?.limit) === 6000, "…recorded in the agent's history", newest);
  const raised = (await limitItems(ids.maker)).filter((n) => n.notice === "raised");
  check(raised.length === 1, "…and the asker hears it was raised", raised);
  const [answered] = await db.select().from(agentLimitRequest).where(eq(agentLimitRequest.id, second.id));
  check(answered.status === "approved" && answered.decidedBy === ids.owner, "the request keeps who answered and how", answered);
  check((await limits.pendingLimitRequest(ids.maker, helper.id)) === null, "nothing waits any more");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

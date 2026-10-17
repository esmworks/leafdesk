/**
 * End-to-end check of who is asked to answer an agent's waiting call, with a fake OpenAI-compatible
 * server as the model and a connection whose one tool writes (so every call of it waits; nothing is
 * ever sent: each call is declined or runs out of time). Two owners; a database only the first can
 * open. A run on its row, and a schedule's run on it, ask only the owner who can open it; a run an
 * owner asked for, or a schedule without a database set, asks only that owner; a connection's event
 * asks every owner. An owner who isn't asked gets no inbox item, doesn't see the call's input in
 * their inbox or the agent's runs, and can't answer it. A row no owner can open asks no one, and
 * its call runs out of time. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-approvers-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, connection, notification, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createRows } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { pageAccessOf } = await import("@/server/access");
const { seal } = await import("@/server/secret-box");
const agents = await import("@/server/agents/manage");
const { expireApprovals, flushAgentRuns, queueAgentRun } = await import("@/server/agents/run");
const { setAgentGrant } = await import("@/server/connections/manage");
const { ApprovalError, decideApproval } = await import("@/server/connections/approvals");
const { listInbox } = await import("@/server/notifications");
const { namespacedTool } = await import("@/lib/connections");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
type AgentRunSource = import("@/lib/agents").AgentRunSource;
type AgentRunContext = import("@/lib/agents").AgentRunContext;
type ApprovalDecision = import("@/lib/agents").ApprovalDecision;

const RUN = `approvers-e2e-${Date.now().toString(36)}`;

registerCollab(createCollab().service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

// Every check runs, so a run against a build without the rule lists each place it leaks.
let passed = 0;
let failed = 0;
function check(condition: unknown, label: string, detail?: unknown) {
  if (!condition) {
    failed++;
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    return;
  }
  passed++;
  console.log(`ok    ${label}`);
}

const ids = { first: `${RUN}-oya`, second: `${RUN}-onur`, member: `${RUN}-mert` };
const workspaceId = `${RUN}-ws`;

/** What a waiting call carries: the row's text, which only those who can open the row may read. */
const secretOf = (what: string) => `SECRET-${what}-${RUN}`;

try {
  await db.insert(user).values([
    { id: ids.first, name: "Owner Oya", email: `${ids.first}@example.test` },
    { id: ids.second, name: "Owner Onur", email: `${ids.second}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.first, role: "owner" },
    { workspaceId, userId: ids.second, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);

  // A connection with one writing tool: every call of it waits for an answer.
  const [conn] = await db
    .insert(connection)
    .values({
      workspaceId,
      name: "Notes",
      slug: "notes",
      url: "https://notes.example.test/mcp",
      authType: "none",
      status: "ready",
      tools: [{ name: "send_note", title: null, description: "Sends a note", inputSchema: { type: "object", properties: { note: { type: "string" } } }, hinted: "write", kind: "write" }],
      eventSecret: seal("approvers-e2e-secret"),
      createdBy: ids.first,
    })
    .returning();
  const agent = await agents.createAgent(ids.first, workspaceId, { name: "Note taker" });
  await setAgentGrant(ids.first, agent.id, conn.id, ["send_note"]);

  // A database only the first owner can open, the agent may edit; a row in it.
  const leads = await createPage({ userId: ids.first }, { workspaceId, teamspaceId: null, kind: "database", title: "Private leads" });
  await agents.setAgentAccess(ids.first, agent.id, leads.id, "edit");
  const [lead] = await createRows(ids.first, leads.id, [{ title: `Lead ${RUN}` }]);
  await setPagePermission(ids.first, leads.id, ids.first, "full");
  await setPagePermission(ids.first, leads.id, null, "none");
  // A second one only the member can open: no owner can.
  const hidden = await createPage({ userId: ids.first }, { workspaceId, teamspaceId: null, kind: "database", title: "Member's leads" });
  await agents.setAgentAccess(ids.first, agent.id, hidden.id, "edit");
  const [hiddenLead] = await createRows(ids.first, hidden.id, [{ title: `Hidden lead ${RUN}` }]);
  await setPagePermission(ids.first, hidden.id, ids.member, "full");
  await setPagePermission(ids.first, hidden.id, null, "none");
  await setPagePermission(ids.member, hidden.id, ids.first, "none");

  const level = async (userId: string, pageId: string) => (await pageAccessOf(userId, pageId)).level;
  check(
    (await level(ids.first, lead.id)) !== "none" && (await level(ids.second, lead.id)) === "none" && (await level(ids.second, leads.id)) === "none",
    "setup: the first owner can open the row and its database, the second can't",
  );
  check(
    (await level(ids.first, hiddenLead.id)) === "none" && (await level(ids.second, hiddenLead.id)) === "none" && (await level(ids.member, hiddenLead.id)) !== "none",
    "setup: no owner can open the member's row",
  );

  const tool = namespacedTool(conn.slug, "send_note");
  let prompts = 0;
  /** Queues a run whose agent calls the tool with `secret` in its input; returns it once it waits. */
  async function waitingRun(source: AgentRunSource, context: AgentRunContext, secret: string) {
    fake.setChat((request: FakeChatRequest): FakeReply =>
      request.messages.some((m) => m.role === "tool") ? { text: "Done." } : { toolCalls: [{ name: tool, arguments: { note: secret } }] },
    );
    const id = await queueAgentRun({ agentId: agent.id, workspaceId, source, context, prompt: `Send a note (${++prompts}).` });
    await flushAgentRuns();
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, id));
    check(run.status === "awaiting_approval", `${secret}: the run waits for an answer`, { status: run.status, code: run.code, error: run.error });
    return run;
  }
  const askedOf = async (runId: string) =>
    (await db.select({ userId: notification.userId }).from(notification).where(and(eq(notification.agentRunId, runId), eq(notification.kind, "agent_approval")))).map((n) => n.userId).sort();
  const inboxShows = async (userId: string, secret: string) => JSON.stringify(await listInbox(userId, workspaceId)).includes(secret);
  const runsShow = async (userId: string, runId: string, secret: string) => {
    const run = (await agents.listAgentRuns(userId, agent.id, 30, { exact: true })).find((r) => r.id === runId);
    return run?.pending !== null && JSON.stringify(run).includes(secret);
  };
  /** An answer's refusal code, or null when it was taken. */
  const answer = (userId: string, run: typeof agentRun.$inferSelect, decision: ApprovalDecision) =>
    decideApproval(userId, { runId: run.id, callId: run.pending!.callId, decision }).then(
      () => null,
      (error: unknown) => (error instanceof ApprovalError ? error.code : String(error)),
    );

  /** A run only `asked` may answer (of the two owners): checked from both sides, then declined by them. */
  async function onlyAsks(what: string, source: AgentRunSource, context: AgentRunContext, asked: string) {
    const other = asked === ids.first ? ids.second : ids.first;
    const secret = secretOf(what);
    const run = await waitingRun(source, context, secret);
    check(JSON.stringify(await askedOf(run.id)) === JSON.stringify([asked]), `${what}: only the owner who may answer it is asked`, await askedOf(run.id));
    check(await inboxShows(asked, secret), `${what}: their inbox shows the call's input`);
    check(await runsShow(asked, run.id, secret), `${what}: …and so do the agent's runs`);
    check(!(await inboxShows(other, secret)), `${what}: the other owner's inbox doesn't show it`);
    check(!(await runsShow(other, run.id, secret)), `${what}: …nor do the agent's runs`);
    // An item they were given before (when they could still open the row, say) isn't shown either,
    // not even as answered: the call still waits.
    await db.insert(notification).values({ userId: other, workspaceId, kind: "agent_approval", actorId: agent.userId, agentRunId: run.id });
    const stale = (await listInbox(other, workspaceId)).filter((item) => item.kind === "agent_approval");
    check(stale.length === 0, `${what}: an item the other owner was given earlier isn't in their inbox`, stale);
    const refused = await answer(other, run, "decline");
    check(refused === "forbidden", `${what}: the other owner can't answer it`, refused);
    const taken = await answer(asked, run, "decline");
    check(taken === null, `${what}: the owner asked answers it`, taken);
    await flushAgentRuns();
  }

  // ── A row's run: the owners who can open the row ─────────────────────────────────────────────
  await onlyAsks(
    "row",
    { kind: "automation", automationId: `${RUN}-auto`, automationRunId: `${RUN}-auto-run`, databaseId: leads.id, rowId: lead.id },
    { created: true, changed: [], actorId: ids.first },
    ids.first,
  );

  // ── A schedule's run on a database: the owners who can open the database ─────────────────────
  await onlyAsks(
    "schedule-on-database",
    { kind: "schedule", scheduleId: `${RUN}-schedule-1`, scheduledBy: ids.first, databaseId: leads.id },
    { actorId: ids.first, scheduledFor: new Date().toISOString() },
    ids.first,
  );

  // ── A run an owner asked for: that owner alone, whoever else can open what it read ───────────
  await onlyAsks("request-by-first", { kind: "request", requestedBy: ids.first, via: "api" }, { actorId: ids.first }, ids.first);
  await onlyAsks("request-by-second", { kind: "request", requestedBy: ids.second, via: "mcp" }, { actorId: ids.second }, ids.second);
  await onlyAsks(
    "request-on-row",
    { kind: "request", requestedBy: ids.first, via: "api", rowId: lead.id, databaseId: leads.id },
    { actorId: ids.first },
    ids.first,
  );

  // ── A schedule without a database: the owner who set it ──────────────────────────────────────
  await onlyAsks("schedule", { kind: "schedule", scheduleId: `${RUN}-schedule-2`, scheduledBy: ids.second }, { actorId: ids.second, scheduledFor: new Date().toISOString() }, ids.second);

  // ── A connection's event: every owner ───────────────────────────────────────────────────────
  {
    const secret = secretOf("event");
    const run = await waitingRun({ kind: "connection", connectionId: conn.id, triggerId: `${RUN}-trigger`, eventId: `${RUN}-event` }, { eventType: "note", body: "{}" }, secret);
    check(JSON.stringify(await askedOf(run.id)) === JSON.stringify([ids.first, ids.second].sort()), "event: every owner is asked", await askedOf(run.id));
    check((await inboxShows(ids.first, secret)) && (await inboxShows(ids.second, secret)), "event: both inboxes show the call's input");
    check((await runsShow(ids.first, run.id, secret)) && (await runsShow(ids.second, run.id, secret)), "event: …and so do the agent's runs, for both");
    const taken = await answer(ids.second, run, "decline");
    check(taken === null, "event: either owner answers it", taken);
    await flushAgentRuns();
  }

  // ── A row no owner can open: no one is asked, and the call runs out of time ──────────────────
  {
    const secret = secretOf("hidden-row");
    const run = await waitingRun(
      { kind: "automation", automationId: `${RUN}-auto`, automationRunId: `${RUN}-auto-run-2`, databaseId: hidden.id, rowId: hiddenLead.id },
      { created: true, changed: [], actorId: ids.member },
      secret,
    );
    check((await askedOf(run.id)).length === 0, "hidden row: no owner is asked", await askedOf(run.id));
    check(!(await inboxShows(ids.first, secret)) && !(await inboxShows(ids.second, secret)), "hidden row: no inbox shows the call's input");
    check(!(await runsShow(ids.first, run.id, secret)) && !(await runsShow(ids.second, run.id, secret)), "hidden row: …nor do the agent's runs");
    const refused = [await answer(ids.first, run, "approve"), await answer(ids.second, run, "approve")];
    check(refused.every((code) => code === "forbidden"), "hidden row: no owner can answer it", refused);
    check(refused.every((code) => code !== null) && (await answer(ids.member, run, "approve")) === "forbidden", "hidden row: nor can the member who can open it, who owns nothing");
    await db.update(agentRun).set({ nextAt: new Date(Date.now() - 1_000) }).where(eq(agentRun.id, run.id));
    await expireApprovals();
    const [expired] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    check(expired.status === "failed" && expired.code === "approvalTimeout", "hidden row: unanswered, it fails when its time is up, sending nothing", { status: expired.status, code: expired.code });
  }

  const sent = await db.select({ steps: agentRun.steps }).from(agentRun).where(eq(agentRun.agentId, agent.id));
  check(!sent.some((r) => r.steps.some((s) => s.kind === "tool" && s.outcome === "done")), "no call was sent");
} catch (error) {
  failed++;
  console.error(error);
} finally {
  console.log(`\n${passed} checks passed, ${failed} failed`);
  // Agents' own users go with their workspace only when it is deleted through the app.
  const bots = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId)).catch((e) => console.error("cleanup", e));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...bots])).catch((e) => console.error("cleanup", e));
  await fake.close();
  process.exit(failed ? 1 : 0);
}

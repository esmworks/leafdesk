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
 * Then owners' rules, quiet hours and the daily limit, against a fake MCP server that does receive
 * calls: a declined tool is never called (reading or writing); an allowed write goes without
 * asking, but still waits on a run a connection's event started; in quiet hours an allowed write
 * waits asking no one, and goes once they end (or asks, when the rule went meanwhile), unless an
 * owner approves it first; past the limit a change is refused.
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

// The fake MCP server the rules' checks call, on a port of its own.
const MCP_PORT = 30_000 + Math.floor(Math.random() * 20_000);
process.env.CONNECTOR_ALLOWED_HOSTS = `localhost:${MCP_PORT}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { createServer } = await import("node:http");
const z = await import("zod");
const { McpServer, createMcpHandler } = await import("@modelcontextprotocol/server");
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentDailyChange, agentRun, connection, notification, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { createRows } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { pageAccessOf } = await import("@/server/access");
const { seal } = await import("@/server/secret-box");
const agents = await import("@/server/agents/manage");
const { expireApprovals, flushAgentRuns, queueAgentRun, wakeDeferred } = await import("@/server/agents/run");
const { setAgentGrant } = await import("@/server/connections/manage");
const { ApprovalError, decideApproval } = await import("@/server/connections/approvals");
const { listInbox } = await import("@/server/notifications");
const { APPROVAL_TIMEOUT_MS, namespacedTool } = await import("@/lib/connections");
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

/** The calls the fake MCP server received, by tool. */
const received: { tool: string; note: string }[] = [];
const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "fake-desk", version: "1.0.0" });
  server.registerTool("send_note", { description: "Sends a note", inputSchema: z.object({ note: z.string() }) }, ({ note }) => {
    received.push({ tool: "send_note", note });
    return { content: [{ type: "text" as const, text: "sent" }] };
  });
  server.registerTool("find_notes", { description: "Finds notes", inputSchema: z.object({ note: z.string() }), annotations: { readOnlyHint: true } }, ({ note }) => {
    received.push({ tool: "find_notes", note });
    return { content: [{ type: "text" as const, text: "[]" }] };
  });
  return server;
});
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://localhost:${MCP_PORT}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await mcp.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => http.listen(MCP_PORT, "::", resolve));

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

  // ── Owners' rules, quiet hours and the daily limit, with calls that are sent ─────────────────
  const [desk] = await db
    .insert(connection)
    .values({
      workspaceId,
      name: "Desk",
      slug: "desk",
      url: `http://localhost:${MCP_PORT}/mcp`,
      authType: "none",
      status: "ready",
      tools: [
        { name: "send_note", title: null, description: "Sends a note", inputSchema: { type: "object", properties: { note: { type: "string" } } }, hinted: "write", kind: "write" },
        { name: "find_notes", title: null, description: "Finds notes", inputSchema: { type: "object", properties: { note: { type: "string" } } }, hinted: "read", kind: "read" },
      ],
      eventSecret: seal("approvers-e2e-secret"),
      createdBy: ids.first,
    })
    .returning();
  const deskAgent = await agents.createAgent(ids.first, workspaceId, { name: "Desk keeper" });
  const send = namespacedTool(desk.slug, "send_note");
  const find = namespacedTool(desk.slug, "find_notes");
  const request: AgentRunSource = { kind: "request", requestedBy: ids.first, via: "api" };
  const event: AgentRunSource = { kind: "connection", connectionId: desk.id, triggerId: `${RUN}-desk-trigger`, eventId: `${RUN}-desk-event` };

  /** Runs `agentId` once, its model calling `calls` in one turn; returns the run as it stands after. */
  async function runCalling(agentId: string, source: AgentRunSource, calls: { name: string; note: string }[]) {
    fake.setChat((req: FakeChatRequest): FakeReply =>
      req.messages.some((m) => m.role === "tool") ? { text: "Done." } : { toolCalls: calls.map((c) => ({ name: c.name, arguments: { note: c.note } })) },
    );
    const context: AgentRunContext = source.kind === "connection" ? { eventType: "note", body: "{}" } : { actorId: ids.first };
    const id = await queueAgentRun({ agentId, workspaceId, source, context, prompt: `Use the desk (${++prompts}).` });
    await flushAgentRuns();
    const [run] = await db.select().from(agentRun).where(eq(agentRun.id, id));
    return run;
  }
  const deskSteps = (run: typeof agentRun.$inferSelect) => run.steps.filter((s) => s.kind === "tool" && s.connectionId === desk.id);
  const got = (note: string) => received.filter((r) => r.note === note).length;
  const rerun = async (runId: string) => {
    await flushAgentRuns();
    return (await db.select().from(agentRun).where(eq(agentRun.id, runId)))[0];
  };

  // Declined tools: neither the read nor the write is called.
  await setAgentGrant(ids.first, deskAgent.id, desk.id, ["send_note", "find_notes"], { send_note: "deny", find_notes: "deny" });
  {
    const note = `deny-${RUN}`;
    const run = await runCalling(deskAgent.id, request, [
      { name: find, note },
      { name: send, note },
    ]);
    const steps = deskSteps(run);
    check(run.status === "done", "deny: the run ends without waiting", { status: run.status, code: run.code });
    check(steps.length === 2 && steps.every((s) => s.kind === "tool" && s.outcome === "denied"), "deny: both calls are recorded as declined by a rule", steps);
    check(got(note) === 0, "deny: the server received neither call");
    check((await askedOf(run.id)).length === 0, "deny: no one is asked");
  }

  // An allowed write goes without asking.
  await setAgentGrant(ids.first, deskAgent.id, desk.id, ["send_note", "find_notes"], { send_note: "allow" });
  {
    const note = `allow-${RUN}`;
    const run = await runCalling(deskAgent.id, request, [{ name: send, note }]);
    const steps = deskSteps(run);
    check(run.status === "done", "allow: the run doesn't wait", { status: run.status, code: run.code, error: run.error });
    check(got(note) === 1, "allow: the server received the call once");
    check(steps.length === 1 && steps[0].kind === "tool" && steps[0].outcome === "done" && steps[0].rule === "allow" && !steps[0].decidedBy, "allow: the step says a rule allowed it", steps);
    check((await askedOf(run.id)).length === 0, "allow: no one is asked");
  }

  // …but not on a run an untrusted event started: it waits for an owner as before.
  {
    const note = `allow-event-${RUN}`;
    const run = await runCalling(deskAgent.id, event, [{ name: send, note }]);
    check(run.status === "awaiting_approval" && !run.pending?.deferredUntil, "allow on an event's run: the call waits for an owner", { status: run.status, pending: run.pending });
    check(got(note) === 0, "allow on an event's run: nothing is sent yet");
    check((await askedOf(run.id)).length === 2, "allow on an event's run: the owners are asked", await askedOf(run.id));
    check((await answer(ids.first, run, "decline")) === null, "allow on an event's run: an owner declines it");
    await flushAgentRuns();
    check(got(note) === 0, "allow on an event's run: declined, it is never sent");
  }

  // Quiet hours: an allowed write waits, asking no one, until they end.
  const hhmm = (offsetHours: number) => new Date(Date.now() + offsetHours * 3_600_000).toISOString().slice(11, 16);
  const quietNow = { start: hhmm(-1), end: hhmm(1), timeZone: "UTC" };
  const quietLater = { start: hhmm(2), end: hhmm(3), timeZone: "UTC" };
  const quietly = async (what: string) => {
    await agents.updateAgent(ids.first, deskAgent.id, { quietHours: quietNow });
    const note = `${what}-${RUN}`;
    const run = await runCalling(deskAgent.id, request, [{ name: send, note }]);
    const until = run.pending?.deferredUntil ? new Date(run.pending.deferredUntil).getTime() : 0;
    check(run.status === "awaiting_approval" && until > Date.now(), `${what}: the call is held for quiet hours`, { status: run.status, pending: run.pending });
    check(Math.abs((run.nextAt?.getTime() ?? 0) - until) < 1_000 && until - Date.now() <= 3_600_000 + 60_000, `${what}: the run is taken again when they end`, { nextAt: run.nextAt, until });
    check((await askedOf(run.id)).length === 0, `${what}: no one is asked or told`, await askedOf(run.id));
    check(got(note) === 0, `${what}: nothing is sent yet`);
    // Not a call that ran out of time: the expiry passes over it.
    await db.update(agentRun).set({ nextAt: new Date(Date.now() - 1_000) }).where(eq(agentRun.id, run.id));
    await expireApprovals();
    const [still] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    check(still.status === "awaiting_approval", `${what}: a held call doesn't expire`, { status: still.status, code: still.code });
    await db.update(agentRun).set({ nextAt: new Date(until) }).where(eq(agentRun.id, run.id));
    return { run: still, note };
  };
  {
    const { run, note } = await quietly("quiet");
    await agents.updateAgent(ids.first, deskAgent.id, { quietHours: quietLater });
    await wakeDeferred();
    const [early] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    check(early.status === "awaiting_approval", "quiet: the sweep leaves it until its time", { status: early.status });
    await db.update(agentRun).set({ nextAt: new Date(Date.now() - 1_000) }).where(eq(agentRun.id, run.id));
    await wakeDeferred();
    const after = await rerun(run.id);
    check(after.status === "done", "quiet: once they end, the run goes on", { status: after.status, code: after.code, error: after.error });
    check(got(note) === 1, "quiet: …and the call is sent");
    const steps = deskSteps(after);
    check(steps.length === 1 && steps[0].kind === "tool" && steps[0].rule === "allow", "quiet: as a rule allowed it", steps);
    check((await askedOf(run.id)).length === 0, "quiet: no one was asked");
  }
  {
    const { run, note } = await quietly("quiet-approved");
    check((await answer(ids.first, run, "approve")) === null, "quiet-approved: an owner can approve the held call early");
    const after = await rerun(run.id);
    check(after.status === "done" && got(note) === 1, "quiet-approved: it is sent at once", { status: after.status, code: after.code, error: after.error });
    const steps = deskSteps(after);
    check(steps.length === 1 && steps[0].kind === "tool" && steps[0].decidedBy === ids.first, "quiet-approved: the step names who approved it", steps);
  }
  {
    const { run, note } = await quietly("quiet-rule-gone");
    await setAgentGrant(ids.first, deskAgent.id, desk.id, ["send_note", "find_notes"], {});
    await agents.updateAgent(ids.first, deskAgent.id, { quietHours: quietLater });
    await db.update(agentRun).set({ nextAt: new Date(Date.now() - 1_000) }).where(eq(agentRun.id, run.id));
    await wakeDeferred();
    const after = await rerun(run.id);
    const nextIn = (after.nextAt?.getTime() ?? 0) - Date.now();
    check(after.status === "awaiting_approval" && !after.pending?.deferredUntil, "quiet-rule-gone: without the rule the call waits for an owner", { status: after.status, pending: after.pending });
    check(Math.abs(nextIn - APPROVAL_TIMEOUT_MS) < 120_000, "quiet-rule-gone: …for the usual time", { nextIn });
    check(JSON.stringify(await askedOf(run.id)) === JSON.stringify([ids.first]), "quiet-rule-gone: the owner who asked for the run is asked now", await askedOf(run.id));
    check(got(note) === 0, "quiet-rule-gone: nothing is sent");
    check((await answer(ids.first, run, "decline")) === null, "quiet-rule-gone: the owner declines it");
    await flushAgentRuns();
  }

  // The daily limit: the change past it is refused.
  {
    const counter = await agents.createAgent(ids.first, workspaceId, { name: "Counter", dailyChangeLimit: 1 });
    await setAgentGrant(ids.first, counter.id, desk.id, ["send_note"], { send_note: "allow" });
    const first = `limit-1-${RUN}`;
    const second = `limit-2-${RUN}`;
    const run = await runCalling(counter.id, request, [
      { name: send, note: first },
      { name: send, note: second },
    ]);
    const steps = deskSteps(run);
    check(run.status === "done", "limit: the run ends", { status: run.status, code: run.code, error: run.error });
    check(got(first) === 1 && got(second) === 0, "limit: the first change is sent, the second isn't");
    check(steps.length === 2 && steps[0].kind === "tool" && steps[0].outcome === "done" && steps[1].kind === "tool" && steps[1].outcome === "limited", "limit: the second is recorded as past the limit", steps);
    const counted = await db.select().from(agentDailyChange).where(eq(agentDailyChange.agentId, counter.id));
    check(counted.length === 1 && counted[0].count === 1, "limit: one change is counted for the day", counted);
    const again = await runCalling(counter.id, request, [{ name: send, note: `limit-3-${RUN}` }]);
    check(got(`limit-3-${RUN}`) === 0 && deskSteps(again).every((s) => s.kind === "tool" && s.outcome === "limited"), "limit: a later run that day is refused too", deskSteps(again));
  }
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
  http.close();
  process.exit(failed ? 1 : 0);
}

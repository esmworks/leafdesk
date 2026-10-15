/**
 * End-to-end check of the wins log, with a fake OpenAI-compatible server (src/server/ai/fake-openai.ts):
 * the built-in template makes a page with a dashboard over a database of wins (its properties,
 * views, row template and example rows, the charts working out from them); the built-in wins logger
 * is set up on that database with a trigger on a connection; a signed event runs it, and the row
 * it adds waits for an owner's approval while the trigger isn't trusted (added once approved,
 * never when declined) and is added at once when it is; an event that isn't a win adds nothing.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/wins-log-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { createHmac } = await import("node:crypto");
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, connection, connectionTrigger, databaseView, notification, page, pagePermission, teamspace, user, workspace, workspaceAgent, workspaceMember } =
  await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { getProperties } = await import("@/server/databases");
const { createFromBuiltin } = await import("@/server/templates");
const { DASHBOARD_BLOCK, parseDashboard } = await import("@/lib/dashboard");
const { DATABASE_BLOCK } = await import("@/lib/embed-blocks");
const { widgetData } = await import("@/server/dashboards");
const { seal } = await import("@/server/secret-box");
const { receiveEvent } = await import("@/server/connections/events");
const { decideApproval } = await import("@/server/connections/approvals");
const { updateTrigger } = await import("@/server/connections/manage");
const { installBuiltinAgent } = await import("@/server/agents/builtin");
const { flushAgentRuns } = await import("@/server/agents/run");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;

const RUN = `wins-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
setAiEnv({
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
});

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

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
  }
}

const ids = { owner: `${RUN}-owner` };
const workspaceId = `${RUN}-ws`;
const SECRET = "wins-e2e-signing-secret";

/** A Slack message event, signed as Slack signs. */
function slackEvent(connectionId: string, eventId: string, text: string) {
  const body = JSON.stringify({ type: "event_callback", event_id: eventId, event: { type: "message", user: "U1", text } });
  const t = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${t}:${body}`).digest("hex")}`;
  return receiveEvent(
    connectionId,
    new Request(`http://localhost/api/connections/${connectionId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Slack-Signature": signature, "X-Slack-Request-Timestamp": String(t) },
      body,
    }),
  );
}

try {
  await db.insert(user).values({ id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: ids.owner, role: "owner" });
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };

  // ── The template: a page with a dashboard over the database ─────────────────────────────────
  const made = await createFromBuiltin(owner, workspaceId, "wins-log", { locale: "en", teamspaceId: general.id });
  const [host] = await db.select().from(page).where(eq(page.id, made.id));
  check(host.kind === "page" && host.title === "Wins log" && host.icon === "🏆" && host.teamspaceId === general.id, "the template makes a page in the teamspace", host);
  const [log] = await db.select().from(page).where(and(eq(page.parentId, host.id), eq(page.kind, "database")));
  check(log?.title === "Wins", "…with the database of wins inside it", log);
  const props = await getProperties(log.id);
  const byName = new Map(props.map((p) => [p.name, p]));
  check(
    ["Type", "Area", "Date", "Impact", "Source", "People"].every((n) => byName.has(n)) && !props.some((p) => p.type === "status") && byName.get("Source")?.type === "url",
    "the database has the log's properties and no starter status",
    props.map((p) => [p.name, p.type]),
  );
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, log.id)).orderBy(databaseView.position);
  const board = views.find((v) => v.type === "board");
  check(views[0]?.name === "All wins" && board?.name === "By type" && board.config.groupBy === byName.get("Type")!.id, "a table of all wins and a board by type", views);
  const rows = await db.select().from(page).where(and(eq(page.parentId, log.id), eq(page.isTemplate, false)));
  const templates = await db.select().from(page).where(and(eq(page.parentId, log.id), eq(page.isTemplate, true)));
  check(rows.length === 5 && templates.length === 1 && log.defaultTemplateId === templates[0].id, "five example rows and a default row template", { rows: rows.length, templates: templates.length });

  const { blocks } = await service.readBlocks(host.id);
  const types = (blocks as { type: string }[]).map((b) => b.type);
  const dashboard = (blocks as { type: string; props: Record<string, string> }[]).find((b) => b.type === DASHBOARD_BLOCK);
  const embedded = (blocks as { type: string; props: Record<string, string> }[]).find((b) => b.type === DATABASE_BLOCK);
  check(
    !!dashboard && !!embedded && types.indexOf(DASHBOARD_BLOCK) < types.indexOf(DATABASE_BLOCK) && embedded.props.databaseId === log.id,
    "the page shows the dashboard, then the database",
    types,
  );
  const widgets = parseDashboard(dashboard.props.widgets);
  check(widgets.length === 4 && widgets.every((w) => w.databaseId === log.id), "the dashboard has four widgets on the database", widgets);
  const [total, byMonth, byArea] = await Promise.all(widgets.slice(0, 3).map((w) => widgetData(owner, w)));
  check(total.state === "ok" && total.kind === "number" && total.rowCount === 5, "the number counts every win", total);
  check(
    byMonth.state === "ok" &&
      byMonth.kind === "chart" &&
      byMonth.groupById === byName.get("Date")!.id &&
      byMonth.stackById === byName.get("Type")!.id &&
      (byMonth.chart?.groups.filter((g) => g.amount > 0).length ?? 0) > 1 &&
      (byMonth.chart?.series.length ?? 0) > 1,
    "wins by month are stacked by type, over more than one month",
    byMonth,
  );
  check(byArea.state === "ok" && byArea.kind === "chart" && byArea.groupById === byName.get("Area")!.id && byArea.chart?.total === 5, "wins by area count them all", byArea);

  // ── The wins logger, on a connection's events ───────────────────────────────────────────────
  check(
    (await failure(installBuiltinAgent(ids.owner, workspaceId, { key: "wins-logger", databaseId: log.id, connectionId: "nope" }))) === "notFound",
    "it needs a connection of the workspace",
  );
  const [conn] = await db
    .insert(connection)
    .values({ workspaceId, name: "Team chat", slug: "teamchat", url: "https://chat.example.test/mcp", authType: "none", status: "ready", eventPreset: "slack", eventSecret: seal(SECRET), createdBy: ids.owner })
    .returning();
  const installed = await installBuiltinAgent(ids.owner, workspaceId, { key: "wins-logger", databaseId: log.id, connectionId: conn.id, eventType: "message" }, { locale: "en" });
  const agent = installed.agent;
  check(
    agent.name === "Wins logger" &&
      agent.icon === "🏆" &&
      agent.instructions.includes(`database_id ${log.id}`) &&
      agent.instructions.includes("- “Type”: one of “Feedback”, “Delivery”, “Metric”, “Event”, “Other”") &&
      agent.instructions.includes("- “Date”: the day it happened") &&
      agent.instructions.includes("“Team chat”"),
    "the agent's instructions name the log, its properties and options, and the connection",
    agent.instructions,
  );
  const [trigger] = await db.select().from(connectionTrigger).where(eq(connectionTrigger.id, installed.triggerId!));
  check(installed.automationId === null && trigger.agentId === agent.id && trigger.eventType === "message" && !trigger.trusted && trigger.enabled, "a trigger on the connection runs it, not trusted", trigger);
  const [share] = await db.select().from(pagePermission).where(and(eq(pagePermission.pageId, log.id), eq(pagePermission.userId, agent.userId)));
  check(share?.level === "edit", "the log is shared with the agent to edit", share);

  const winRow = (request: FakeChatRequest): FakeReply => {
    const added = request.messages.some((m) => m.role === "tool");
    if (added) return { text: "Logged the praise." };
    return {
      toolCalls: [
        {
          name: "create_row",
          arguments: { database_id: log.id, title: "Ada praised the release notes", properties: { Type: "Feedback", Area: "Product", Impact: "Medium" }, content: "“Best release notes yet.” (Ada)" },
        },
      ],
    };
  };
  const seen: FakeChatRequest[] = [];
  fake.setChat((request) => {
    seen.push(request);
    return winRow(request);
  });
  const rowsNow = async () => (await db.select({ id: page.id, title: page.title, createdBy: page.createdBy, properties: page.properties }).from(page).where(and(eq(page.parentId, log.id), eq(page.isTemplate, false))));
  const runOf = async () => (await db.select().from(agentRun).where(eq(agentRun.agentId, agent.id)).orderBy(agentRun.createdAt)).at(-1)!;

  const sent = await slackEvent(conn.id, `${RUN}-1`, "Best release notes yet, thanks team!");
  check(sent.status === 202 && sent.body.runs === 1, "a message event starts the agent", sent);
  await flushAgentRuns();
  const first = seen[0];
  check(first.tools?.some((t) => t.function.name === "create_row") && !first.tools?.some((t) => t.function.name === "update_row"), "an event's run may add rows, and change none", first.tools?.map((t) => t.function.name));
  check(
    first.messages.some((m) => textOf(m.content).includes("Each row is added only after a person approves it")),
    "…and is told each row waits for approval",
  );
  let waiting = await runOf();
  check(
    waiting.status === "awaiting_approval" && waiting.pending?.connectionId === null && waiting.pending?.tool === "create_row" && (await rowsNow()).length === 5,
    "while the trigger isn't trusted, the row waits for an owner",
    { status: waiting.status, pending: waiting.pending },
  );
  const inbox = await db.select().from(notification).where(and(eq(notification.agentRunId, waiting.id), eq(notification.kind, "agent_approval")));
  check(inbox.length === 1 && inbox[0].userId === ids.owner, "the owner gets it in their inbox", inbox);
  await decideApproval(ids.owner, { runId: waiting.id, callId: waiting.pending!.callId, decision: "approve" });
  await flushAgentRuns();
  waiting = await runOf();
  const added = (await rowsNow()).find((r) => r.title === "Ada praised the release notes");
  check(waiting.status === "done" && !!added && added.createdBy === agent.userId, "approved, the row is added, by the agent", { status: waiting.status, code: waiting.code, error: waiting.error, added });
  check(
    added.properties[byName.get("Type")!.id] === byName.get("Type")!.options.options!.find((o) => o.name === "Feedback")!.id &&
      added.properties[byName.get("Impact")!.id] === byName.get("Impact")!.options.options!.find((o) => o.name === "Medium")!.id,
    "…with the values the agent chose",
    added.properties,
  );
  check(waiting.steps.some((s) => s.kind === "write" && s.outcome === "done"), "the run shows the row it added", waiting.steps);

  // Declined: nothing is added.
  await slackEvent(conn.id, `${RUN}-2`, "Another great review from a customer");
  await flushAgentRuns();
  waiting = await runOf();
  await decideApproval(ids.owner, { runId: waiting.id, callId: waiting.pending!.callId, decision: "decline" });
  await flushAgentRuns();
  waiting = await runOf();
  check(
    waiting.status === "done" && (await rowsNow()).length === 6 && waiting.steps.some((s) => s.kind === "tool" && s.connectionId === null && s.outcome === "declined"),
    "declined, no row is added and the run says so",
    waiting.steps,
  );

  // Not a win: no row and nothing to approve.
  fake.setChat(() => ({ text: "Not a win: a lunch order." }));
  await slackEvent(conn.id, `${RUN}-3`, "Who wants pizza for lunch?");
  await flushAgentRuns();
  waiting = await runOf();
  check(waiting.status === "done" && waiting.pending === null && (await rowsNow()).length === 6, "an event that isn't a win adds nothing", waiting);

  // Trusted: the row is added at once.
  fake.setChat(winRow);
  await updateTrigger(ids.owner, trigger.id, { trusted: true });
  await db.delete(page).where(eq(page.id, added.id));
  await slackEvent(conn.id, `${RUN}-4`, "Best release notes yet, again!");
  await flushAgentRuns();
  waiting = await runOf();
  check(waiting.status === "done" && (await rowsNow()).some((r) => r.title === "Ada praised the release notes"), "with a trusted trigger the row is added without asking", waiting);

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((r) => r.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  const userIds = [ids.owner, ...botUsers];
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

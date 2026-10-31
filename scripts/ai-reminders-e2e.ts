/**
 * End-to-end check of reminders agents set (server/ai-reminders.ts) against the database, with a
 * fake OpenAI-compatible server: a chat run is offered `remind_person` on the clock of the zone
 * the message came with; the reminder waits snoozed (no run, no email), out of the inbox and the
 * window over the page until its time, when the snooze sweep brings it in from the agent, with
 * its text and page, and the person's windows are told; a time without an offset reads on the
 * zone's clock; what is no time, gone by or too far ahead, pages the person or the agent can't open
 * and calls past the per-run limit are refused; one about no page shows too; an agent has at most
 * MAX_WAITING_REMINDERS waiting for a person, even when runs set them at once; one turned off in
 * the inbox doesn't open over the page.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-reminders-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it with no app
 * server on the same database: the server's workers would take the runs and wake the reminders.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, notification, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { deliverSnoozed, dueReminders, listNotifications, snoozeNotification } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { MAX_REMINDERS_PER_RUN, MAX_WAITING_REMINDERS } = await import("@/lib/ai-reminders");
const { REMINDER_EVENT } = await import("@/lib/reminder-event");
const { REMIND_TOOL_NAME, remindersSet, setReminder } = await import("@/server/ai-reminders");
const agents = await import("@/server/agents/manage");
const chat = await import("@/server/agents/chat");
const { flushAgentRuns } = await import("@/server/agents/run");

const RUN = `ai-reminders-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
// What the server tells people's windows, to see the reminder's own event.
const sentTo: string[] = [];
const sendTo = service.sendTo.bind(service);
service.sendTo = (channel, userId, event) => {
  sentTo.push(`${channel} ${userId} ${event}`);
  return sendTo(channel, userId, event);
};
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

const toolNames = (request: FakeChatRequest) => (request.tools ?? []).map((t) => t.function.name);
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

/** A model that makes these tool calls (each entry one turn), then says `done`. */
function caller(turns: NonNullable<FakeReply["toolCalls"]>[], done = "Done.") {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    return made < turns.length ? { toolCalls: turns[made] } : { text: done };
  };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const workspaceId = `${RUN}-ws`;

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
  const offer = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: general.id, title: "Offer for Ayşe" });
  // Private to the owner: neither the member nor the agent opens it.
  const diary = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: null, title: "Diary" });
  const helper = await agents.createAgent(ids.owner, workspaceId, { name: "Desk helper", instructions: "Help with the desk." });
  await agents.setAgentAccess(ids.owner, helper.id, offer.id, "view");

  const reminders = () => db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "ai_reminder")));
  const inbox = async (userId: string) => (await listNotifications(userId, { workspaceId })).filter((n) => n.kind === "ai_reminder");

  // ── A chat run sets one ─────────────────────────────────────────────────────────────────────
  const soon = new Date(Date.now() + 10 * 60_000);
  fake.chats.length = 0;
  fake.setChat(caller([[{ name: REMIND_TOOL_NAME, arguments: { text: "Call Ayşe about the offer", at: soon.toISOString(), page_id: offer.id } }]], "I'll remind you."));
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Remind me in ten minutes to call Ayşe.", timeZone: "Europe/Istanbul" });
  await flushAgentRuns();
  const tool = fake.chats[0].tools?.find((t) => t.function.name === REMIND_TOOL_NAME) as { function: { name: string; description?: string } } | undefined;
  check(tool, "a chat run is offered remind_person", toolNames(fake.chats[0]));
  check(/in Europe\/Istanbul/.test(tool.function.description ?? "") && /"\d{4}-\d{2}-\d{2}T09:00"/.test(tool.function.description ?? ""), "…on the clock of the zone the message came with", tool.function.description);
  check(/^Reminder set for \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Istanbul\)\.$/.test(toolResults(fake.chats.at(-1)!)[0]), "the model hears when, on that clock", toolResults(fake.chats.at(-1)!));
  const [set] = await reminders();
  check(
    set &&
      set.userId === ids.owner &&
      set.actorId === helper.userId &&
      set.pageId === offer.id &&
      set.message === "Call Ayşe about the offer" &&
      set.snoozedUntil?.getTime() === soon.getTime() &&
      set.agentRunId === null &&
      set.emailDueAt === null,
    "it is the owner's notification from the agent, snoozed until its time, with no run and no email",
    set,
  );
  const [run] = await db.select().from(agentRun).where(eq(agentRun.agentId, helper.id));
  check(run.steps.some((s) => s.kind === "tool" && s.tool === REMIND_TOOL_NAME && s.outcome === "done" && s.input.includes("Call Ayşe")), "it is a step of the run", run.steps);
  check(remindersSet(run.steps) === 1, "…which a resumed run counts toward its limit", run.steps);
  check((await inbox(ids.owner)).length === 0 && (await dueReminders(ids.owner, workspaceId)).length === 0, "until its time it is neither in the inbox nor over the page");

  // ── Its time comes ──────────────────────────────────────────────────────────────────────────
  check((await deliverSnoozed(new Date(soon.getTime() + 1000))) >= 1, "the snooze sweep wakes it at its time");
  check(sentTo.includes(`ws:${workspaceId} ${ids.owner} ${REMINDER_EVENT}`), "…and tells the person's windows it came", sentTo);
  const [shown] = await inbox(ids.owner);
  check(
    shown?.aiReminder?.text === "Call Ayşe about the offer" && shown.aiReminder.agentId === helper.id && shown.aiReminder.agentName === "Desk helper" && shown.pageId === offer.id && !shown.read && shown.automationMessage === null,
    "then it is in the inbox, unread, from the agent, with its text and page",
    shown,
  );
  check((await dueReminders(ids.owner, workspaceId, new Date(soon.getTime() + 2000))).map((r) => r.id).join() === shown.id, "…and opens over the page");
  check((await dueReminders(ids.owner, workspaceId, new Date(soon.getTime() + 13 * 3_600_000))).length === 0, "…but not half a day later: then it waits in the inbox");
  check((await inbox(ids.member)).length === 0, "nobody else gets it");
  const woke = new Date(soon.getTime() + 2000);
  const again = new Date(woke.getTime() + 3_600_000);
  await snoozeNotification(ids.owner, shown.id, again, woke);
  await deliverSnoozed(new Date(again.getTime() + 1000));
  const [rewoken] = await dueReminders(ids.owner, workspaceId, new Date(again.getTime() + 2000));
  check(rewoken?.id === shown.id && rewoken.createdAt.getTime() === again.getTime(), "snoozed for an hour, it opens over the page again then, as of its new time", rewoken);

  // ── What is refused ─────────────────────────────────────────────────────────────────────────
  const person = { workspaceId, agentUserId: helper.userId, personId: ids.owner, timeZone: "Europe/Istanbul" };
  const call = (args: Record<string, unknown>) => ({ id: "c", name: REMIND_TOOL_NAME, arguments: args });
  const before = (await reminders()).length;
  const refused = await Promise.all([
    setReminder(person, call({ text: "x", at: "tomorrow at 9" })),
    setReminder(person, call({ text: "x", at: new Date(Date.now() - 3_600_000).toISOString() })),
    setReminder(person, call({ text: "x", at: new Date(Date.now() + 40 * 86_400_000).toISOString() })),
    setReminder(person, call({ text: "   ", at: soon.toISOString() })),
    setReminder(person, call({ text: "x", at: soon.toISOString(), page_id: diary.id })),
    setReminder({ ...person, personId: ids.member }, call({ text: "x", at: soon.toISOString(), page_id: diary.id })),
  ]);
  check(refused.every((r) => r.isError), "what is no time, a time gone by or too far ahead, no text, or a page one of them can't open is refused", refused);
  check(/date and time/.test(refused[0].content) && /passed/.test(refused[1].content) && /30 days/.test(refused[2].content), "…each with a reason the model can act on", refused.map((r) => r.content));
  check((await reminders()).length === before, "…and none is set");

  // ── A time on their clock ───────────────────────────────────────────────────────────────────
  const hourAhead = new Date(Date.now() + 3_600_000);
  const wall = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(hourAhead).replace(" ", "T");
  const onClock = await setReminder(person, call({ text: "On the clock", at: wall }));
  const [clocked] = (await reminders()).filter((r) => r.message === "On the clock");
  check(!onClock.isError && clocked?.snoozedUntil?.getTime() === Math.floor(hourAhead.getTime() / 60_000) * 60_000, "a time without an offset is the time on the person's clock", { wall, onClock, at: clocked?.snoozedUntil });
  await db.delete(notification).where(eq(notification.id, clocked.id));

  // ── One about no page, and the limits ───────────────────────────────────────────────────────
  const now = new Date();
  const plain = await setReminder(person, call({ text: "Stretch", at: now.toISOString() }), now);
  check(!plain.isError, "a reminder about no page is set", plain);
  await deliverSnoozed(new Date(now.getTime() + 1000));
  check((await inbox(ids.owner)).some((n) => n.aiReminder?.text === "Stretch" && n.pageId === null), "…and shows in the inbox while they are in the workspace");

  fake.chats.length = 0;
  const later = new Date(Date.now() + 3_600_000).toISOString();
  fake.setChat(caller([Array.from({ length: MAX_REMINDERS_PER_RUN + 1 }, (_, i) => ({ name: REMIND_TOOL_NAME, arguments: { text: `Thing ${i + 1}`, at: later } }))]));
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Remind me of four things." });
  await flushAgentRuns();
  const limited = toolResults(fake.chats.at(-1)!);
  check(limited.filter((r) => r.startsWith("Reminder set")).length === MAX_REMINDERS_PER_RUN && /the most one run may set/.test(limited.at(-1) ?? ""), "one run sets at most MAX_REMINDERS_PER_RUN", limited);
  check(/\(UTC\)/.test(limited[0]), "a message with no zone reads times in UTC", limited[0]);

  const waiting = (await reminders()).filter((r) => r.snoozedUntil && r.snoozedUntil > new Date()).length;
  for (let i = waiting; i < MAX_WAITING_REMINDERS - 2; i++) await setReminder(person, call({ text: `Wait ${i}`, at: later }));
  const atOnce = await Promise.all(Array.from({ length: 5 }, (_, i) => setReminder(person, call({ text: `At once ${i}`, at: later }))));
  const over = atOnce.filter((r) => r.isError);
  const stillWaiting = (await reminders()).filter((r) => r.snoozedUntil && r.snoozedUntil > new Date()).length;
  check(
    over.length === 3 && over.every((r) => /20 reminders waiting/.test(r.content)) && stillWaiting === MAX_WAITING_REMINDERS,
    "an agent has at most MAX_WAITING_REMINDERS waiting for a person, even when they are set at once",
    { over, stillWaiting },
  );

  // ── Turned off ──────────────────────────────────────────────────────────────────────────────
  await setNotificationPreference(ids.owner, "ai_reminder", "inbox", false);
  check((await dueReminders(ids.owner, workspaceId)).length === 0 && (await inbox(ids.owner)).length === 0, "turned off in the inbox, they neither show there nor over the page");
  await setNotificationPreference(ids.owner, "ai_reminder", "inbox", true);

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...Object.values(ids), ...botUsers]));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

/**
 * End-to-end check of reminders agents set (server/ai-reminders.ts) against the database, with a
 * fake OpenAI-compatible server: a chat run is offered `remind_person` on the clock of the zone
 * the message came with; the reminder waits snoozed (no run, no email), out of the inbox and the
 * window over the page until its time, when the snooze sweep brings it in from the agent, with
 * its text and page, and the person's windows are told; a time without an offset reads on the
 * zone's clock; what is no time, gone by or too far ahead, pages the person or the agent can't open
 * and calls past the per-run limit are refused; one about no page shows too; an agent has at most
 * MAX_WAITING_REMINDERS waiting for a person, even when runs set them at once; one turned off in
 * the inbox doesn't open over the page. Until they come, the person alone sees them (and what they
 * snoozed) soonest first, with their time and page, and moves or cancels them: a cancelled one is
 * gone and frees its place under the limit; a snoozed notification comes back at once. They are on
 * the person's Calendar at their time (nobody else's), opening their page or else the inbox, and
 * dragged to another time there; never to a whole day, a time gone by, nor one that has come. The AI chat sets one for the person asking, asked about
 * first (unless on Auto) with its text and time on their clock, never in research; it shows in the
 * inbox as their own; declined, none is set. It lists the person's reminders still to come (theirs
 * and agents', with ids, never anyone else's) and cancels or moves one, asked about first (unless
 * on Auto, and again once an agent's words were read); an agent lists, cancels and moves only those
 * it set for that person. Asked for a routine, the chat is told it is an agent's
 * schedule, which it adds through use_tool, asked about each time.
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
const { and, desc, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentRun, notification, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { cancelReminder, deliverSnoozed, dueReminders, listNotifications, listPending, snoozeNotification, unsnoozeNotification } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { CHANGE_REMINDER_TOOL_NAME, LIST_REMINDERS_TOOL_NAME, MAX_REMINDERS_PER_RUN, MAX_WAITING_REMINDERS } = await import("@/lib/ai-reminders");
const { REMINDER_EVENT } = await import("@/lib/reminder-event");
const { REMIND_TOOL_NAME, remindersSet, setReminder } = await import("@/server/ai-reminders");
const agents = await import("@/server/agents/manage");
const chat = await import("@/server/agents/chat");
const { flushAgentRuns } = await import("@/server/agents/run");
const { startChat } = await import("@/server/ai-chat");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { listAgentSchedules } = await import("@/server/agents/schedules");
const { CalendarMoveError, calendarItems, moveCalendarItem } = await import("@/server/calendar");
const { dayString, localDay } = await import("@/lib/time-zone");
type ChatInput = import("@/server/ai-chat").ChatInput;
type ChatActionView = import("@/lib/ai-chat").ChatActionView;
type ChatEvent = import("@/lib/ai-chat").ChatEvent;

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
  check(/^Reminder set for \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Istanbul\)\. It waits under Scheduled in their inbox/.test(toolResults(fake.chats.at(-1)!)[0]), "the model hears when, on that clock", toolResults(fake.chats.at(-1)!));
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
  const person = { workspaceId, actorId: helper.userId, personId: ids.owner, timeZone: "Europe/Istanbul" };
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

  // ── Still to come: seen, moved, cancelled ───────────────────────────────────────────────────
  const pending = await listPending(ids.owner, workspaceId);
  check(
    pending.length === stillWaiting &&
      pending.every((n) => n.kind === "ai_reminder" && n.snoozedUntil && n.snoozedUntil > new Date() && n.aiReminder?.agentName === "Desk helper" && n.aiReminder.text),
    "the person sees every reminder still to come, with its time, its text and who set it",
    pending.map((n) => ({ kind: n.kind, at: n.snoozedUntil, reminder: n.aiReminder })),
  );
  check((await listPending(ids.member, workspaceId)).length === 0, "…and nobody else sees them");
  const last = pending.at(-1)!;
  const sooner = new Date(Date.now() + 20 * 60_000);
  check(!(await snoozeNotification(ids.member, last.id, sooner)), "nobody else moves one");
  check(await snoozeNotification(ids.owner, last.id, sooner), "the person moves one to another time");
  const moved = await listPending(ids.owner, workspaceId);
  check(moved[0]?.id === last.id && moved[0].snoozedUntil?.getTime() === sooner.getTime() && !moved[0].read, "…and it comes first: soonest first, at its new time", moved[0]);
  check(!(await unsnoozeNotification(ids.owner, last.id)), "a reminder isn't brought back early, only moved or cancelled");
  check(!(await cancelReminder(ids.member, last.id)), "nobody else cancels one");
  check(await cancelReminder(ids.owner, last.id), "the person cancels one");
  check(!(await reminders()).some((r) => r.id === last.id) && (await listPending(ids.owner, workspaceId)).length === stillWaiting - 1, "…which is gone, never to come");
  check(!(await cancelReminder(ids.owner, last.id)), "…and can't be cancelled twice");
  const freed = await setReminder(person, call({ text: "After cancelling", at: later }));
  check(!freed.isError, "a cancelled one no longer counts toward the agent's limit", freed);
  check(/under Scheduled in their inbox, where they may move or cancel it/.test(freed.content), "the model hears where the person sees it", freed.content);

  // ── On the Calendar ─────────────────────────────────────────────────────────────────────────
  const today = localDay(Date.now(), "UTC");
  const range = { from: dayString(today), to: dayString(today + 2), timeZone: "UTC" };
  const toCome = await listPending(ids.owner, workspaceId);
  await db.update(notification).set({ pageId: offer.id }).where(eq(notification.id, toCome[0].id));
  const onCalendar = (await calendarItems(ids.owner, workspaceId, range)).filter((item) => item.kind === "reminder");
  const paged = onCalendar.find((item) => item.id === `reminder:${toCome[0].id}`);
  const plainOne = onCalendar.find((item) => item.id === `reminder:${toCome[1].id}`);
  check(
    onCalendar.length === toCome.length &&
      onCalendar.every((item) => item.detail === "Desk helper" && item.moves?.allDay === false && item.title && item.icon === null) &&
      paged?.href === `/w/${workspaceId}/p/${offer.id}` &&
      paged.date === toCome[0].snoozedUntil?.toISOString() &&
      plainOne?.href === null &&
      plainOne.title === toCome[1].aiReminder?.text,
    "every reminder still to come is on the person's Calendar at its time, by its agent, opening its page or else the inbox",
    { onCalendar, toCome: toCome.map((n) => ({ id: n.id, at: n.snoozedUntil, page: n.pageId })) },
  );
  check(!(await calendarItems(ids.member, workspaceId, range)).some((item) => item.kind === "reminder"), "…and on nobody else's");
  const farRange = { from: dayString(today + 40), to: dayString(today + 45), timeZone: "UTC" };
  check(!(await calendarItems(ids.owner, workspaceId, farRange)).some((item) => item.kind === "reminder"), "…only on the days of their time");
  const dropAt = new Date((Math.floor(Date.now() / 900_000) + 8) * 900_000);
  await moveCalendarItem(ids.owner, workspaceId, `reminder:${toCome[1].id}`, dropAt.toISOString(), "UTC");
  const [droppedRow] = await db.select({ at: notification.snoozedUntil, readAt: notification.readAt }).from(notification).where(eq(notification.id, toCome[1].id));
  check(droppedRow?.at?.getTime() === dropAt.getTime() && droppedRow.readAt === null, "dragged to another time, it comes then", droppedRow);
  const moveFails = async (userId: string, id: string, value: string) => {
    try {
      await moveCalendarItem(userId, workspaceId, `reminder:${id}`, value, "UTC");
      return null;
    } catch (error) {
      return error instanceof CalendarMoveError ? error.code : String(error);
    }
  };
  check((await moveFails(ids.owner, toCome[1].id, dayString(today + 1))) === "fixed", "…but never to a whole day");
  check((await moveFails(ids.owner, toCome[1].id, new Date(Date.now() - 60_000).toISOString())) === "fixed", "…nor to a time gone by");
  check((await moveFails(ids.owner, toCome[1].id, new Date(Date.now() + 31 * 86_400_000).toISOString())) === "fixed", "…nor more than 30 days ahead");
  check((await moveFails(ids.member, toCome[1].id, dropAt.toISOString())) === "notFound", "nobody else moves it");
  const stretch = (await inbox(ids.owner)).find((n) => n.aiReminder?.text === "Stretch");
  check(stretch && (await moveFails(ids.owner, stretch.id, dropAt.toISOString())) === "notFound", "one that has come isn't sent back by a stale calendar", stretch);
  const [stretchRow] = await db.select({ at: notification.snoozedUntil }).from(notification).where(eq(notification.id, stretch.id));
  check(stretchRow?.at === null, "…and stays in the inbox", stretchRow);
  const [shared] = await db
    .insert(notification)
    .values({ userId: ids.owner, workspaceId, kind: "page_shared", actorId: ids.member, pageId: offer.id, snoozedUntil: new Date(Date.now() + 86_400_000) })
    .returning({ id: notification.id });
  const withSnoozed = (await listPending(ids.owner, workspaceId)).at(-1);
  check(withSnoozed?.id === shared.id && withSnoozed.pageTitle === "Offer for Ayşe" && withSnoozed.snoozedUntil, "a snoozed notification is still to come too, with its page", withSnoozed);
  check(!(await cancelReminder(ids.owner, shared.id)), "…which isn't cancelled, being no reminder");
  check(await unsnoozeNotification(ids.owner, shared.id), "…but brought back now");
  const back = (await listNotifications(ids.owner, { workspaceId })).find((n) => n.id === shared.id);
  check(back && !back.read && back.snoozedUntil === null && !(await listPending(ids.owner, workspaceId)).some((n) => n.id === shared.id), "…unread in the inbox, no longer to come", back);
  await db.delete(notification).where(eq(notification.id, shared.id));

  // ── The AI chat sets one for the person asking ─────────────────────────────────────────────
  /** Runs a question to the end (the member's, unless `as` says), deciding each approval it asks for. */
  const ask = async (input: Omit<ChatInput, "workspaceId">, decide: "approve" | "decline" = "approve", as = ids.member) => {
    const events: ChatEvent[] = [];
    const asked: ChatActionView[] = [];
    for await (const event of await startChat(as, { workspaceId, timeZone: "Europe/Istanbul", ...input })) {
      events.push(event);
      if (event.type === "approval") {
        asked.push(event.action);
        decideChange(as, event.id, decide);
      }
    }
    return { asked, steps: events.flatMap((e) => (e.type === "step" ? [e.step] : [])), done: events.at(-1)?.type === "done" };
  };
  const ownReminders = async () => (await reminders()).filter((r) => r.userId === ids.member && r.actorId === ids.member);
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
  const systemOf = (request: FakeChatRequest) => String(request.messages.find((m) => m.role === "system")?.content ?? "");
  fake.chats.length = 0;
  fake.setChat(caller([[{ name: REMIND_TOOL_NAME, arguments: { text: "Call Ayşe about the offer", at: `${tomorrow}T09:00`, page_id: offer.id } }]], "I'll remind you."));
  const chatSet = await ask({ message: "Remind me tomorrow at 9 to call Ayşe", mode: "ask" });
  check(
    toolNames(fake.chats[0]).includes(REMIND_TOOL_NAME) && /remind_person/.test(systemOf(fake.chats[0])) && /set_agent_schedule/.test(systemOf(fake.chats[0])),
    "the AI chat offers remind_person, and its rules say routines are an agent's schedule",
    systemOf(fake.chats[0]).slice(0, 400),
  );
  check(
    chatSet.asked.length === 1 && chatSet.asked[0].action === "remind" && chatSet.asked[0].title === "Call Ayşe about the offer" && chatSet.asked[0].content === `${tomorrow} 09:00`,
    "…asks first, with its text and the time on the person's clock",
    chatSet.asked,
  );
  const [own] = await ownReminders();
  check(
    chatSet.done && own?.pageId === offer.id && own.snoozedUntil?.toISOString() === new Date(`${tomorrow}T06:00:00Z`).toISOString(),
    "…then sets it for them, from them, about the page, at 9:00 in Istanbul",
    own,
  );
  check(
    chatSet.steps.some((st) => st.kind === "reminder" && !st.action && st.outcome === "done" && st.when === `${tomorrow} 09:00` && st.text === "Call Ayşe about the offer"),
    "…as a step of the answer",
    chatSet.steps,
  );
  await db.update(notification).set({ snoozedUntil: new Date(Date.now() - 1_000) }).where(eq(notification.id, own.id));
  await deliverSnoozed();
  const ownItem = (await inbox(ids.member)).find((n) => n.id === own.id);
  check(
    ownItem?.aiReminder?.own === true && ownItem.aiReminder.agentName === null && ownItem.aiReminder.text === "Call Ayşe about the offer",
    "in the inbox it is their own reminder, named by no agent",
    ownItem?.aiReminder,
  );

  fake.setChat(caller([[{ name: REMIND_TOOL_NAME, arguments: { text: "Water the plants", at: `${tomorrow}T18:00` } }]], "Okay."));
  const declined = await ask({ message: "Remind me to water the plants at six tomorrow", mode: "ask" }, "decline");
  check(
    (await ownReminders()).length === 1 && declined.steps.some((st) => st.kind === "reminder" && !st.action && st.outcome === "declined"),
    "declined, no reminder is set, and the step says so",
    declined.steps,
  );
  fake.setChat(caller([[{ name: REMIND_TOOL_NAME, arguments: { text: "Water the plants", at: `${tomorrow}T18:00` } }]], "Okay."));
  const auto = await ask({ message: "Remind me to water the plants at six tomorrow", mode: "auto" });
  check(auto.asked.length === 0 && (await ownReminders()).length === 2, "on Auto it is set without asking");
  fake.chats.length = 0;
  fake.setChat(() => ({ text: "A report." }));
  await ask({ message: "Research the offers", research: true });
  check(
    fake.chats.length > 0 && fake.chats.every((c) => ![REMIND_TOOL_NAME, LIST_REMINDERS_TOOL_NAME, CHANGE_REMINDER_TOOL_NAME].some((name) => toolNames(c).includes(name))),
    "research isn't offered it, nor listing or changing reminders",
  );

  // ── The AI chat lists the person's reminders, and cancels or moves one ─────────────────────
  // One the agent set for the member too, beside the member's own; and one of the owner's own.
  const fromAgent = await setReminder({ workspaceId, actorId: helper.userId, personId: ids.member, timeZone: "Europe/Istanbul" }, call({ text: "Send Ayşe the contract", at: `${tomorrow}T11:00` }));
  check(!fromAgent.isError, "an agent sets one for the member", fromAgent);
  await setReminder({ workspaceId, actorId: ids.owner, personId: ids.owner, timeZone: "Europe/Istanbul" }, call({ text: "Owner's own", at: `${tomorrow}T12:00` }));
  const waitingFor = async (userId: string) => (await reminders()).filter((r) => r.userId === userId && r.snoozedUntil && r.snoozedUntil > new Date());
  const [plants] = (await waitingFor(ids.member)).filter((r) => r.message === "Water the plants");
  const [contract] = (await waitingFor(ids.member)).filter((r) => r.message === "Send Ayşe the contract");
  const [ownersOwn] = (await waitingFor(ids.owner)).filter((r) => r.message === "Owner's own");

  fake.chats.length = 0;
  fake.setChat(caller([[{ name: LIST_REMINDERS_TOOL_NAME, arguments: {} }]], "You have two."));
  const listed = await ask({ message: "Which reminders do I have?", mode: "ask" });
  check(toolNames(fake.chats[0]).includes(LIST_REMINDERS_TOOL_NAME) && toolNames(fake.chats[0]).includes(CHANGE_REMINDER_TOOL_NAME), "the AI chat offers list_reminders and change_reminder", toolNames(fake.chats[0]));
  const list = toolResults(fake.chats.at(-1)!)[0] ?? "";
  check(
    /^2 reminders still to come, soonest first \(times on their clock in Europe\/Istanbul\)/.test(list) &&
      list.indexOf("Send Ayşe the contract") < list.indexOf("Water the plants") &&
      list.includes(`id ${plants.id} · ${tomorrow} 18:00 · "Water the plants" · set by them`) &&
      list.includes(`id ${contract.id} · ${tomorrow} 11:00 · "Send Ayşe the contract" · set by the agent "Desk helper"`),
    "…which lists the person's reminders still to come, soonest first, on their clock, with their ids and who set them",
    list,
  );
  check(!list.includes("Call Ayşe about the offer") && !list.includes("Owner's own") && !list.includes("Wait "), "…never one that came, nor anyone else's", list);
  check(
    listed.asked.length === 0 && listed.steps.some((st) => st.kind === "reminder" && st.action === "list" && st.results === 2 && st.others),
    "…without asking, as a step that marks an agent's words read",
    listed.steps,
  );

  fake.setChat(caller([[{ name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "cancel", reminder_id: plants.id } }]], "Cancelled."));
  const keep = await ask({ message: "Cancel the one about the plants", mode: "ask" }, "decline");
  check(
    keep.asked[0]?.action === "cancelReminder" && keep.asked[0].title === "Water the plants" && keep.asked[0].content === `${tomorrow} 18:00` && keep.asked[0].eachTime === true,
    "cancelling one is asked about first, with its text and time",
    keep.asked,
  );
  check((await waitingFor(ids.member)).some((r) => r.id === plants.id) && keep.steps.some((st) => st.kind === "reminder" && st.action === "cancel" && st.outcome === "declined"), "…declined, it stays", keep.steps);
  fake.setChat(caller([[{ name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "cancel", reminder_id: plants.id } }]], "Cancelled."));
  const cancelled = await ask({ message: "Cancel the one about the plants", mode: "ask" });
  check(
    !(await reminders()).some((r) => r.id === plants.id) && cancelled.steps.some((st) => st.kind === "reminder" && st.action === "cancel" && st.outcome === "done" && st.text === "Water the plants"),
    "…approved, it is gone, as a step of the answer",
    cancelled.steps,
  );

  fake.setChat(caller([[{ name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "move", reminder_id: contract.id, at: `${tomorrow}T15:30` } }]], "Moved."));
  const moveAuto = await ask({ message: "Move the contract one to 15:30", mode: "auto" });
  const [contractNow] = (await reminders()).filter((r) => r.id === contract.id);
  check(
    moveAuto.asked.length === 0 && contractNow.snoozedUntil?.toISOString() === new Date(`${tomorrow}T12:30:00Z`).toISOString() && contractNow.actorId === helper.userId,
    "on Auto, one an agent set is moved without asking, to the time on the person's clock",
    { asked: moveAuto.asked, at: contractNow.snoozedUntil },
  );
  check(moveAuto.steps.some((st) => st.kind === "reminder" && st.action === "move" && st.when === `${tomorrow} 15:30`), "…as a step with its new time", moveAuto.steps);
  fake.setChat(caller([[{ name: LIST_REMINDERS_TOOL_NAME, arguments: {} }], [{ name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "move", reminder_id: contract.id, at: `${tomorrow}T16:00` } }]], "Moved."));
  const afterList = await ask({ message: "What do I have, and move the contract one to 16:00", mode: "auto" }, "decline");
  check(afterList.asked[0]?.action === "moveReminder" && afterList.asked[0].reminderWas === `${tomorrow} 15:30` && afterList.asked[0].eachTimeReason === "outside", "…but once an agent's reminder was read, Auto asks again, showing both times", afterList.asked);

  fake.setChat(
    caller(
      [
        [
          { name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "cancel", reminder_id: ownersOwn.id } },
          { name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "move", reminder_id: contract.id, at: "next week" } },
          { name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "snooze", reminder_id: contract.id } },
        ],
      ],
      "Couldn't.",
    ),
  );
  fake.chats.length = 0;
  const refusedChanges = await ask({ message: "Cancel the owner's reminder", mode: "auto" });
  const why = toolResults(fake.chats.at(-1)!);
  check(
    refusedChanges.asked.length === 0 && /no reminder still to come with that id/.test(why[0]) && /date and time/.test(why[1]) && /"cancel" or "move"/.test(why[2]),
    "someone else's reminder, a time that is none or an action it hasn't are refused, each with a reason, before anyone is asked",
    why,
  );
  check((await waitingFor(ids.owner)).some((r) => r.id === ownersOwn.id), "…and the other person's reminder stays");

  // ── An agent lists, cancels and moves only the reminders it set ────────────────────────────
  fake.chats.length = 0;
  fake.setChat(caller([[{ name: LIST_REMINDERS_TOOL_NAME, arguments: {} }]], "Here they are."));
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Which reminders did you set for me?", timeZone: "Europe/Istanbul" });
  await flushAgentRuns();
  check(toolNames(fake.chats[0]).includes(LIST_REMINDERS_TOOL_NAME) && toolNames(fake.chats[0]).includes(CHANGE_REMINDER_TOOL_NAME), "an agent's chat run is offered both tools", toolNames(fake.chats[0]));
  const agentList = toolResults(fake.chats.at(-1)!)[0] ?? "";
  const helperWaiting = (await waitingFor(ids.owner)).filter((r) => r.actorId === helper.userId);
  check(
    agentList.startsWith(`${helperWaiting.length} reminders still to come`) && !agentList.includes("Owner's own") && !agentList.includes("set by") && !agentList.includes("Send Ayşe the contract"),
    "…which lists only those it set for that person: not theirs, nor others'",
    agentList.slice(0, 300),
  );
  const target = helperWaiting[0];
  fake.setChat(
    caller([
      [
        { name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "cancel", reminder_id: ownersOwn.id } },
        { name: CHANGE_REMINDER_TOOL_NAME, arguments: { action: "move", reminder_id: target.id, at: `${tomorrow}T07:15` } },
      ],
    ]),
  );
  fake.chats.length = 0;
  await chat.sendAgentChat(ids.owner, { workspaceId, agentId: helper.id, place: null, conversationId: null, message: "Cancel mine and move one of yours to 7:15.", timeZone: "Europe/Istanbul" });
  await flushAgentRuns();
  const agentWhy = toolResults(fake.chats.at(-1)!);
  const [targetNow] = (await reminders()).filter((r) => r.id === target.id);
  check(/no reminder still to come with that id that you set/.test(agentWhy[0]) && (await waitingFor(ids.owner)).some((r) => r.id === ownersOwn.id), "…refuses the person's own", agentWhy);
  check(
    /^Moved: .* now comes at \d{4}-\d{2}-\d{2} 07:15 \(Europe\/Istanbul\)/.test(agentWhy[1]) && targetNow.snoozedUntil?.toISOString() === new Date(`${tomorrow}T04:15:00Z`).toISOString(),
    "…and moves its own",
    { agentWhy, at: targetNow.snoozedUntil },
  );
  const [lastRun] = await db.select().from(agentRun).where(eq(agentRun.agentId, helper.id)).orderBy(desc(agentRun.createdAt)).limit(1);
  check(lastRun.steps.some((st) => st.kind === "tool" && st.tool === CHANGE_REMINDER_TOOL_NAME && st.outcome === "done" && st.input.startsWith(`move ${tomorrow} 07:15 · `)), "…as a step of its run", lastRun.steps);
  check(remindersSet(lastRun.steps) === 0, "…which doesn't count toward the reminders it may set");

  // ── …and hands a routine to an agent as a schedule ────────────────────────────────────────
  // Members make agents only where owners let them: the owner asks.
  const morning = await agents.createAgent(ids.owner, workspaceId, { name: "Morning desk", instructions: "Help me in the mornings." });
  const routineSchedule = {
    agent_id: morning.id,
    action: "add",
    repeat: { frequency: "daily", time: "08:00" },
    time_zone: "Europe/Istanbul",
    task: "List what is due today and tell me.",
  };
  fake.chats.length = 0;
  fake.setChat(
    caller([[{ name: "find_tools", arguments: { query: "agent schedule" } }], [{ name: "use_tool", arguments: { name: "set_agent_schedule", arguments: routineSchedule } }]], "Morning desk will do it every day at 8."),
  );
  const routine = await ask({ message: "Every morning at 8, list what is due today", mode: "auto" }, "approve", ids.owner);
  check(toolResults(fake.chats[1]).some((r) => r.includes("set_agent_schedule")), "find_tools finds set_agent_schedule", toolResults(fake.chats[1]));
  check(routine.asked.length === 1 && routine.asked[0].action === "tool" && routine.asked[0].eachTime === true, "…which is asked about each time, also on Auto", routine.asked);
  const made = await listAgentSchedules(ids.owner, morning.id);
  check(made.length === 1 && made[0].timeZone === "Europe/Istanbul" && made[0].task === routineSchedule.task, "…and puts the routine on the person's agent", made);

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

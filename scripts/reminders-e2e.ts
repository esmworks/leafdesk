/**
 * End-to-end check of date reminders, snoozed notifications and calendar feeds against the
 * database: who a date property's reminder tells and when (assigned people, else whoever added the
 * row; not done rows, other days, people without access, or twice), snoozing an inbox item and its
 * coming back, and a calendar view's secret address (its rows as events, gone with export turned
 * off, replaced or turned off). Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/reminders-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, user, workspace, workspaceMember } = await import("@/db/schema");
const { reminderInstant } = await import("@/lib/date-options");
const { dayString, localDay } = await import("@/lib/time-zone");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty, addView, updateProperty } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { deliverDateReminders, LATE_MS } = await import("@/server/date-reminders");
const { deliverSnoozed, listInbox, snoozeNotification } = await import("@/server/notifications");
const { createCalendarFeed, deleteCalendarFeed, getCalendarFeed, readCalendarFeed } = await import("@/server/calendar-feeds");
const { updateWorkspaceSettings } = await import("@/server/workspaces");

const RUN = `reminders-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

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

async function codeOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const owner = { userId: ids.owner };
const todayNumber = localDay(Date.now(), "UTC");
const day = (offset: number) => dayString(todayNumber + offset);

const remindersOf = (userId: string) =>
  db
    .select({ id: notification.id, pageId: notification.pageId, date: notification.date })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.kind, "reminder")));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.outsider, role: "member" },
  ]);

  // Tasks: Assignee (people), Due (a date reminding a day before) and the default Status.
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date", date: { reminderDays: 1, timeZone: "UTC" } });
  check(due.options.date?.reminder?.daysBefore === 1 && due.options.date.reminder.timeZone === "UTC", "a date property keeps its reminder", due.options);

  const row = (title: string, properties: Record<string, unknown>) =>
    createPage(owner, { workspaceId, parentId: tasks.id, title, properties });
  const assigned = await row("Assigned", { Due: day(2), Assignee: [ids.member] });
  const unassigned = await row("Unassigned", { Due: day(2) });
  await row("Finished", { Due: day(2), Assignee: [ids.member], Status: "Done" });
  await row("Later", { Due: day(3), Assignee: [ids.member] });
  await row("Left", { Due: day(2), Assignee: [ids.outsider] });
  // Assigned, then left the workspace: no longer told.
  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.outsider)));

  // A day before day(2), at 9:00 UTC, a minute after.
  const at = reminderInstant(day(2), due.options.date!.reminder!);
  check(new Date(at).toISOString() === `${day(1)}T09:00:00.000Z`, "the reminder falls at 9:00 in its zone the day before");
  check((await deliverDateReminders(new Date(at - 60_000))) === 0, "nothing is due before the reminder time");
  const told = await deliverDateReminders(new Date(at + 60_000));
  check(told === 2, "the assigned person and the adder of an unassigned row are told", { told });
  const memberReminders = await remindersOf(ids.member);
  check(
    memberReminders.length === 1 && memberReminders[0].pageId === assigned.id && memberReminders[0].date === day(2),
    "…the member about their row, not the finished or later one",
    memberReminders,
  );
  const ownerReminders = await remindersOf(ids.owner);
  check(ownerReminders.length === 1 && ownerReminders[0].pageId === unassigned.id, "…the owner about the row they added", ownerReminders);
  check((await remindersOf(ids.outsider)).length === 0, "someone who left the workspace isn't told");
  check((await deliverDateReminders(new Date(at + 120_000))) === 0, "a reminder goes once");

  // The next day's rows: missed by more than LATE_MS (a server that was down) is skipped.
  const next = reminderInstant(day(3), due.options.date!.reminder!);
  check((await deliverDateReminders(new Date(next + LATE_MS + 60_000))) === 0, "a reminder missed by hours is skipped");

  // A reminder set now doesn't announce dates whose reminder time has passed.
  await updateProperty(ids.owner, due.id, { date: { reminderDays: 0, timeZone: "UTC" } });
  await row("Today", { Due: day(0), Assignee: [ids.member] });
  const todayAt = reminderInstant(day(0), { daysBefore: 0, timeZone: "UTC", since: new Date().toISOString() });
  if (Date.now() > todayAt) {
    check((await deliverDateReminders(new Date(Math.min(Date.now(), todayAt + LATE_MS - 1)))) === 0, "times passed before the reminder was set are skipped");
  }

  const inboxIds = async () => (await listInbox(ids.member, workspaceId)).map((n) => n.id);
  const reminder = memberReminders[0].id;
  check((await inboxIds()).includes(reminder), "the reminder is in the member's inbox");

  // Snoozing.
  const hour = new Date(Date.now() + 3_600_000);
  check(!(await snoozeNotification(ids.owner, reminder, hour)), "someone else's notification can't be snoozed");
  check(!(await snoozeNotification(ids.member, reminder, new Date(Date.now() - 1000))), "nor snoozed into the past");
  check(!(await snoozeNotification(ids.member, reminder, new Date(Date.now() + 40 * 86_400_000))), "nor for more than 30 days");
  check(await snoozeNotification(ids.member, reminder, hour), "the member snoozes it for an hour");
  check(!(await inboxIds()).includes(reminder), "…and it leaves the inbox");
  check((await deliverSnoozed(new Date(hour.getTime() - 1000))) === 0, "it stays away until its time");
  check((await deliverSnoozed(new Date(hour.getTime() + 1000))) >= 1, "then comes back");
  const back = (await listInbox(ids.member, workspaceId)).find((n) => n.id === reminder);
  check(back && !back.readAt && new Date(back.createdAt).getTime() === hour.getTime(), "…unread, dated when it came back", back);

  // Calendar feeds.
  const calendar = await addView(ids.owner, tasks.id, { name: "Calendar", type: "calendar" });
  const table = await addView(ids.owner, tasks.id, { name: "All", type: "table" });
  check((await codeOf(() => createCalendarFeed(ids.owner, table.id))) === "calendarFeedNotCalendar", "only calendar views have a feed");
  check((await codeOf(() => createCalendarFeed(ids.outsider, calendar.id))) !== null, "someone without access gets none");
  check((await getCalendarFeed(ids.owner, calendar.id)).feed === null, "a view has no feed until one is made");

  const address = await createCalendarFeed(ids.owner, calendar.id);
  const secret = address.split("/api/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
  check(/^ldcal_[A-Za-z0-9]{36}$/.test(secret), "the address holds a secret", address);
  const read = await readCalendarFeed(secret);
  check(read.status === 200, "the feed reads", read);
  if (read.status !== 200) throw new Error("unreachable");
  check(read.body.includes("SUMMARY:Assigned\r\n") && read.body.includes(`DTSTART;VALUE=DATE:${day(2).replaceAll("-", "")}`), "…with the rows as all-day events");
  check(read.body.includes(`UID:${assigned.id}@`), "…each row with a stable uid");
  check(read.name === "Tasks · Calendar", "…named after the database and view", read.name);
  check((await getCalendarFeed(ids.owner, calendar.id)).feed?.lastUsedAt, "reading it is recorded");
  check((await readCalendarFeed("ldcal_" + "x".repeat(36))).status === 404, "an unknown secret reads nothing");

  await updateWorkspaceSettings(ids.owner, workspaceId, { export: false });
  check((await readCalendarFeed(secret)).status === 404, "with export off the feed stops");
  check((await codeOf(() => createCalendarFeed(ids.owner, calendar.id))) === "calendarFeedExportOff", "…and none can be made");
  check((await getCalendarFeed(ids.owner, calendar.id)).allowed === false, "…which the dialog is told");
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: true });
  check((await readCalendarFeed(secret)).status === 200, "turned back on, it reads again");

  const replaced = await createCalendarFeed(ids.owner, calendar.id);
  check(replaced !== address && (await readCalendarFeed(secret)).status === 404, "a new address replaces the old one");
  const newSecret = replaced.split("/api/calendar/")[1].replace(/\.ics$/, "");
  await deleteCalendarFeed(ids.owner, calendar.id);
  check((await readCalendarFeed(newSecret)).status === 404, "turned off, it reads nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

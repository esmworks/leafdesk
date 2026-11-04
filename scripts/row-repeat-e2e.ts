/**
 * End-to-end check of rows that come round again (server/row-repeat) against the database: a row
 * marked done opens one copy beside it, its date moved to the next time, done undone, checklists
 * and the body's to-dos unticked, other dates and unique values left behind, a timeline's end date
 * moved along; the rule moves to the copy; two writes marking a row done at once open one copy;
 * marking it not done again takes back an untouched copy, and leaves one someone changed; a writer
 * who may not add rows has the copy added as whoever set the rule, and with neither the rule says
 * so; automations' writes repeat too; the day's cap, the rule's last day, skipping one, a copy put
 * in the trash by hand, who may set a rule, and a duplicated database taking its rows' rules along.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-repeat-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, rowRepeat, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { asAutomation } = await import("@/server/automations/queue");
const { duplicatePage } = await import("@/server/duplicate");
const { setRowRepeat, skipRowRepeat, rowRepeatsOf } = await import("@/server/row-repeat");
const { dayNumber, dayString, localDay, weekdayOf } = await import("@/lib/time-zone");
const { MAX_REPEATS_PER_DAY } = await import("@/lib/row-repeat");

const RUN = `rowrepeat-e2e-${Date.now().toString(36)}`;
const ZONE = "Europe/Istanbul";
const today = dayString(localDay(Date.now(), ZONE));
const plus = (days: number) => dayString(dayNumber(today) + days);

// The real collab service: bodies and titles are written through the rows' documents.
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

async function fails(fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return code === undefined || (error as { code?: string }).code === code;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** The live rows of a database titled `title`, oldest first. */
const live = (databaseId: string, title: string) =>
  db
    .select()
    .from(page)
    .where(and(eq(page.parentId, databaseId), eq(page.title, title), isNull(page.archivedAt), eq(page.isTemplate, false)))
    .orderBy(page.createdAt);
const ruleOn = async (rowId: string) => (await db.select().from(rowRepeat).where(eq(rowRepeat.rowId, rowId)))[0] ?? null;
const body = async (rowId: string) => (await service.readPage(rowId)).markdown;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);

  const actor = { userId: ids.owner };
  const jobs = await createPage(actor, { workspaceId, kind: "database", title: "Jobs" });
  await setPagePermission(ids.owner, jobs.id, ids.owner, "full");
  await setPagePermission(ids.owner, jobs.id, null, "none");
  await setPagePermission(ids.owner, jobs.id, ids.member, "edit");
  await setPagePermission(ids.owner, jobs.id, ids.viewer, "view");
  const status = (await databases.getProperties(jobs.id)).find((p) => p.type === "status")!;
  const options = status.options.options!;
  const todo = options.find((o) => o.group === "todo")!;
  const finished = options.find((o) => o.group === "done")!;
  const due = await databases.addProperty(ids.owner, jobs.id, { name: "Due", type: "date" });
  const end = await databases.addProperty(ids.owner, jobs.id, { name: "End", type: "date" });
  const doneOn = await databases.addProperty(ids.owner, jobs.id, { name: "Done on", type: "date" });
  const steps = await databases.addProperty(ids.owner, jobs.id, { name: "Steps", type: "checklist" });
  const code = await databases.addProperty(ids.owner, jobs.id, { name: "Code", type: "text" });
  await databases.updateProperty(ids.owner, code.id, { unique: true });
  const notes = await databases.addProperty(ids.owner, jobs.id, { name: "Notes", type: "text" });
  await databases.addView(ids.owner, jobs.id, { name: "Plan", type: "timeline", config: { dateBy: due.id, endDateBy: end.id } });
  const markDone = (userId: string, rowId: string) => databases.updateRowProperties(userId, rowId, { [status.id]: finished.id });
  const markOpen = (userId: string, rowId: string) => databases.updateRowProperties(userId, rowId, { [status.id]: todo.id });

  // Who may set a rule
  const service1 = await createPage(actor, {
    workspaceId,
    parentId: jobs.id,
    title: "Service the cooler",
    markdown: "- [x] Clean the filter\n- [ ] Check the gas",
    properties: {
      [status.id]: todo.id,
      [due.id]: today,
      [end.id]: plus(1),
      [doneOn.id]: plus(-1),
      [steps.id]: [
        { text: "Photos", checked: true },
        { text: "Signature", checked: false },
      ],
      [code.id]: `${RUN}-A1`,
      [notes.id]: "Back door",
    },
  });
  const weekly = { frequency: "weekly", from: "due" };
  check(
    await fails(() => setRowRepeat(ids.viewer, service1.id, { propertyId: due.id, rule: weekly, timeZone: ZONE })),
    "someone who can only view the row can't make it repeat",
  );
  check(
    await fails(() => setRowRepeat(ids.owner, service1.id, { propertyId: notes.id, rule: weekly, timeZone: ZONE }), "repeatNotDate"),
    "a rule sits on a date property only",
  );
  check(
    await fails(() => setRowRepeat(ids.owner, service1.id, { propertyId: due.id, rule: { frequency: "hourly" }, timeZone: ZONE }), "invalidRepeat"),
    "a rule that isn't one is refused",
  );
  const set = await setRowRepeat(ids.owner, service1.id, { propertyId: due.id, rule: weekly, timeZone: ZONE });
  check(
    set?.rule.weekdays.length === 1 && set.rule.weekdays[0] === weekdayOf(dayNumber(today)) && set.rule.anchor === today,
    "a weekly rule without weekdays comes round on the date's own weekday",
    set,
  );
  check((await rowRepeatsOf([service1.id]))[service1.id]?.propertyId === due.id, "the row's rule is read back");

  // Marked done: one copy, the rule on it
  await markDone(ids.owner, service1.id);
  const opened = await live(jobs.id, "Service the cooler");
  const first = opened[0];
  let copy = opened[1];
  check(first?.id === service1.id && copy && copy.id !== service1.id, "marking a repeating row done opens a copy with the same title");
  check(copy.properties[due.id] === plus(7), "the copy's date is the next time", copy.properties);
  check(copy.properties[end.id] === plus(8), "the timeline's end moves along with its start", copy.properties);
  check(copy.properties[status.id] === todo.id, "the copy isn't done", copy.properties);
  check(!(doneOn.id in copy.properties), "other dates stay with the done row", copy.properties);
  check(!(code.id in copy.properties), "unique values stay with the done row", copy.properties);
  check(copy.properties[notes.id] === "Back door", "other values come along", copy.properties);
  const items = copy.properties[steps.id] as { text: string; checked: boolean }[];
  check(items.length === 2 && items.every((i) => !i.checked), "checklists start unticked", items);
  const copyBody = await body(copy.id);
  check(copyBody.includes("[ ] Clean the filter") && !copyBody.includes("[x]"), "the body's to-dos start unticked", copyBody);
  check((await body(service1.id)).includes("[x] Clean the filter"), "the done row keeps its ticked to-dos");
  check((await ruleOn(service1.id)) === null && (await ruleOn(copy.id)) !== null, "the rule moved to the copy");
  const copyRule = (await ruleOn(copy.id))!;
  check(copyRule.previousRowId === service1.id && copyRule.spawnCount === 1, "the copy knows the row that opened it", copyRule);

  // Marked done again while done: nothing new
  await databases.updateRowProperties(ids.owner, service1.id, { [notes.id]: "Back door, ring twice" });
  check((await live(jobs.id, "Service the cooler")).length === 2, "other writes to a done row open nothing");

  // Marked not done again: the untouched copy goes back
  await markOpen(ids.owner, service1.id);
  check((await live(jobs.id, "Service the cooler")).length === 1, "marking it not done takes back the untouched copy");
  check((await ruleOn(service1.id))?.chainId === copyRule.chainId, "…and the rule comes back to the row");
  const [trashedCopy] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, copy.id));
  check(trashedCopy.archivedAt !== null, "the copy taken back is in the trash");

  // Done again, then the copy is changed: it stays
  await markDone(ids.owner, service1.id);
  [, copy] = await live(jobs.id, "Service the cooler");
  check(copy && copy.properties[due.id] === plus(7), "done again opens a copy again");
  await databases.updateRowProperties(ids.member, copy.id, { [notes.id]: "Bring the ladder" });
  await markOpen(ids.owner, service1.id);
  check((await live(jobs.id, "Service the cooler")).length === 2, "a copy someone changed isn't taken back");
  check((await ruleOn(copy.id)) !== null && (await ruleOn(service1.id)) === null, "…and keeps the rule");

  // Body changed: stays too
  await markDone(ids.owner, service1.id);
  const second = (await live(jobs.id, "Service the cooler")).at(-1)!;
  await markDone(ids.owner, copy.id);
  let chain = await live(jobs.id, "Service the cooler");
  const third = chain.at(-1)!;
  check(chain.length === 3 && (await ruleOn(third.id)) !== null && second.id === copy.id, "the copy, done in turn, opens the next one", chain.map((c) => c.properties[due.id]));
  check(third.properties[due.id] === plus(14), "…a week after the copy's date");
  await service.appendContent(third.id, "Spare part ordered", actor);
  await markOpen(ids.owner, copy.id);
  chain = await live(jobs.id, "Service the cooler");
  check(chain.length === 3, "a copy whose body someone wrote in isn't taken back");

  // Two writes marking a row done at once
  const twice = await createPage(actor, { workspaceId, parentId: jobs.id, title: "Water the plants", properties: { [status.id]: todo.id, [due.id]: today } });
  await setRowRepeat(ids.owner, twice.id, { propertyId: due.id, rule: { frequency: "daily", interval: 3, from: "done" }, timeZone: ZONE });
  await Promise.all([markDone(ids.owner, twice.id), markDone(ids.member, twice.id)]);
  const plants = await live(jobs.id, "Water the plants");
  check(plants.length === 2, "two writes marking a row done at once open one copy", plants.length);
  check(plants[1].properties[due.id] === plus(3), "a rule counted from the day it was done adds to today", plants[1].properties);

  // An automation's write repeats too
  const auto = await createPage(actor, { workspaceId, parentId: jobs.id, title: "Send the report", properties: { [status.id]: todo.id, [due.id]: today } });
  await setRowRepeat(ids.owner, auto.id, { propertyId: due.id, rule: { frequency: "monthly" }, timeZone: ZONE });
  await asAutomation(() => markDone(ids.owner, auto.id));
  const reports = await live(jobs.id, "Send the report");
  check(reports.length === 2, "a row an automation marks done repeats");

  // The day's cap
  await db.update(rowRepeat).set({ spawnDay: today, spawnCount: MAX_REPEATS_PER_DAY }).where(eq(rowRepeat.rowId, reports[1].id));
  await markDone(ids.owner, reports[1].id);
  check((await live(jobs.id, "Send the report")).length === 2, "a chain that opened its day's share opens no more");
  check((await ruleOn(reports[1].id))?.lastError === "tooMany", "…and its rule says why");

  // The rule's last day
  const ending = await createPage(actor, { workspaceId, parentId: jobs.id, title: "Last call", properties: { [status.id]: todo.id, [due.id]: today } });
  await setRowRepeat(ids.owner, ending.id, { propertyId: due.id, rule: { frequency: "weekly", until: plus(3) }, timeZone: ZONE });
  await markDone(ids.owner, ending.id);
  check((await live(jobs.id, "Last call")).length === 1 && (await ruleOn(ending.id)) === null, "a rule past its last day opens nothing and ends");

  // A writer who may not add rows
  const guestJob = await createPage(actor, { workspaceId, parentId: jobs.id, title: "Replace the seal", properties: { [status.id]: todo.id, [due.id]: today } });
  await setRowRepeat(ids.owner, guestJob.id, { propertyId: due.id, rule: { frequency: "daily", interval: 2, from: "done" }, timeZone: ZONE });
  await setPagePermission(ids.owner, guestJob.id, ids.viewer, "edit");
  await markDone(ids.viewer, guestJob.id);
  const seals = await live(jobs.id, "Replace the seal");
  check(seals.length === 2 && seals[1].createdBy === ids.owner, "a copy the writer may not add is added as whoever set the rule", seals.map((s) => s.createdBy));
  await setPagePermission(ids.owner, seals[1].id, ids.viewer, "edit");
  await setRowRepeat(ids.viewer, seals[1].id, { propertyId: due.id, rule: { frequency: "daily", interval: 2, from: "done" }, timeZone: ZONE });
  await markDone(ids.viewer, seals[1].id);
  check((await live(jobs.id, "Replace the seal")).length === 2, "with neither able to add rows, nothing opens");
  check((await ruleOn(seals[1].id))?.lastError === "accessLost", "…and the rule says why");

  // Skipping one
  const skip = await createPage(actor, { workspaceId, parentId: jobs.id, title: "Check the alarm", properties: { [status.id]: todo.id, [due.id]: today } });
  await setRowRepeat(ids.owner, skip.id, { propertyId: due.id, rule: { frequency: "daily", interval: 5 }, timeZone: ZONE });
  const skipped = await skipRowRepeat(ids.owner, skip.id);
  const [skippedRow] = await db.select().from(page).where(eq(page.id, skip.id));
  check(skipped === plus(5) && skippedRow.properties[due.id] === plus(5), "skipping one moves the date to the next time");
  check((await live(jobs.id, "Check the alarm")).length === 1, "…without a copy");

  // A copy put in the trash by hand ends the chain
  await markDone(ids.owner, skip.id);
  const alarms = await live(jobs.id, "Check the alarm");
  await archivePage(ids.owner, alarms[1].id);
  await markOpen(ids.owner, skip.id);
  await markDone(ids.owner, skip.id);
  check((await live(jobs.id, "Check the alarm")).length === 1, "once its copy is in the trash, the done row opens no other");

  // Stopping
  await setRowRepeat(ids.owner, plants[1].id, null);
  check((await ruleOn(plants[1].id)) === null, "a rule can be turned off");

  // A database without a status or checkbox
  const notesDb = await createPage(actor, { workspaceId, kind: "database", title: "Notes" });
  const notesProps = await databases.getProperties(notesDb.id);
  for (const p of notesProps.filter((p) => p.type === "status" || p.type === "checkbox")) await databases.deleteProperty(ids.owner, p.id);
  const when = await databases.addProperty(ids.owner, notesDb.id, { name: "When", type: "date" });
  const note = await createPage(actor, { workspaceId, parentId: notesDb.id, title: "A note", properties: { [when.id]: today } });
  check(
    await fails(() => setRowRepeat(ids.owner, note.id, { propertyId: when.id, rule: weekly, timeZone: ZONE }), "repeatNeedsDone"),
    "a database with nothing to mark rows done can't repeat them",
  );

  // A duplicated database takes its rows' rules along
  const copied = await duplicatePage(actor, jobs.id);
  const copiedRules = await db.select().from(rowRepeat).where(eq(rowRepeat.databaseId, copied.id));
  // Rows in the trash aren't copied, nor their rules (the alarm's copy put there above).
  const sourceRules = await db
    .select({ chainId: rowRepeat.chainId })
    .from(rowRepeat)
    .innerJoin(page, eq(page.id, rowRepeat.rowId))
    .where(and(eq(rowRepeat.databaseId, jobs.id), isNull(page.archivedAt)));
  check(copiedRules.length === sourceRules.length && copiedRules.length > 0, "a duplicated database's live rows repeat like their sources", {
    copied: copiedRules.length,
    source: sourceRules.length,
  });
  check(
    copiedRules.every((r) => !sourceRules.some((s) => s.chainId === r.chainId)) && copiedRules.every((r) => r.propertyId !== due.id),
    "…each a chain of its own, on the copy's properties",
  );
  const [{ n }] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${rowRepeat} where ${inArray(rowRepeat.rowId, [copied.id])}`,
  );
  check(n === 0, "the copied database itself has no rule");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

/**
 * End-to-end check of "date passed" automations (server/automations/timed) and the "move to
 * trash" action against the database: what is refused when saving, over MCP too; rows not edited
 * for a while getting a status, once, and again only after someone edits them; done rows trashed
 * some days after their date, recorded in the audit log as the automation's doing, not run again
 * once restored but again for a new date; a notification on the day a date comes; trashed rows,
 * templates and databases in the trash left out; the cap per check; the saver's access and
 * deleted properties pausing the check; two checks at once queueing a row once.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/timed-automation-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own workers would take the queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, automationFire, automationRun, databaseAutomation, notification, page, user, workspace, workspaceMember } = await import(
  "@/db/schema"
);
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, deleteProperty, ensureOption, getProperties, restoreProperty, updateRowProperties } = await import("@/server/databases");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { createRowTemplate } = await import("@/server/templates");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { runDatePassedAutomations, serverDay } = await import("@/server/automations/timed");
const { automationInputs, describeAutomation, automationContext, toAutomationInput } = await import("@/server/mcp/automations");
const { listInbox } = await import("@/server/notifications");
const { DATE_PASSED_BATCH } = await import("@/lib/automations");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `timed-automation-e2e-${Date.now().toString(36)}`;
const DAY_MS = 86_400_000;

registerCollab({
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
} as unknown as Parameters<typeof registerCollab>[0]);

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

async function failsWith(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) => error instanceof PropertyValueError && error.code === code,
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** The server's day `days` days before `now`. */
const dayBefore = (now: Date, days: number) => serverDay(new Date(now.getTime() - days * DAY_MS));
const row = async (rowId: string) => (await db.select().from(page).where(eq(page.id, rowId)))[0];
const runsOf = (automationId: string) =>
  db.select().from(automationRun).where(eq(automationRun.automationId, automationId)).orderBy(automationRun.createdAt);
const check1 = (automationId: string, now: Date) => runDatePassedAutomations({ now, automationIds: [automationId] });
const backdate = (rowIds: string[], days: number, now: Date) =>
  db.update(page).set({ updatedAt: new Date(now.getTime() - days * DAY_MS) }).where(inArray(page.id, rowIds));

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  // A new database comes with a Status (Not started, In progress, Done); "Stale" is one more to do.
  await ensureOption(ids.owner, (await getProperties(tasks.id)).find((p) => p.type === "status")!.id, "Stale");
  const status = (await getProperties(tasks.id)).find((p) => p.type === "status")!;
  const completed = await addProperty(ids.owner, tasks.id, { name: "Completed on", type: "date" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const assignee = await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const title = await addProperty(ids.owner, tasks.id, { name: "Note", type: "text" });
  const option = (name: string) => status.options.options!.find((o) => o.name === name)!.id;

  // ------------------------------------------------------------------ saving
  const base = { name: "x", actions: [{ type: "move_to_trash" as const }] };
  const datePassed = (rest: Record<string, unknown>) => ({ type: "date_passed" as const, date: "Completed on", days: 14, ...rest });
  check(await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ days: -1 }) }), "invalidAutomation"), "negative days are refused");
  check(await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ days: 1.5 }) }), "invalidAutomation"), "…and fractions");
  check(await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ days: 4000 }) }), "invalidAutomation"), "…and more than ten years");
  check(await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ date: "Note" }) }), "invalidAutomation"), "a text property is no date to count from");
  check(await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ date: "Nope" }) }), "unknownProperty"), "an unknown property is refused");
  check(
    await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ status: { groups: [] } }) }), "invalidAutomation"),
    "a status condition needs a group",
  );
  check(
    await failsWith(manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ status: { groups: ["later"] } }) }), "invalidAutomation"),
    "…a known one",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { ...base, trigger: datePassed({ status: { property: "Due", groups: ["done"] } }) }),
      "invalidAutomation",
    ),
    "…on a status property",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, {
        name: "x",
        trigger: { type: "row_created" },
        actions: [{ type: "move_to_trash" }, { type: "notify", people: ["me"] }],
      }),
      "invalidAutomation",
    ),
    "moving to the trash is the last action",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, {
        name: "x",
        trigger: { type: "row_created" },
        actions: [{ type: "notify", people: ["me"] }, { type: "move_to_trash" }, { type: "move_to_trash" }],
      }),
      "invalidAutomation",
    ),
    "…and comes once",
  );

  // MCP: the tool's schema and how its input becomes an automation.
  check(!automationInputs.create.safeParse({ database_id: tasks.id, name: "x", trigger: { type: "date_passed", date: "Due", days: -2 }, actions: [{ type: "move_to_trash" }] }).success, "MCP refuses negative days");
  check(
    !automationInputs.create.safeParse({ database_id: tasks.id, name: "x", trigger: { type: "date_passed", date: "Due", days: 1, status: { groups: ["soon"] } }, actions: [{ type: "move_to_trash" }] }).success,
    "…and unknown status groups",
  );
  const mcpArgs = automationInputs.create.parse({
    database_id: tasks.id,
    name: "Overdue nudge (MCP)",
    enabled: false,
    trigger: { type: "date_passed", date: "Due", days: 1, status: { groups: ["todo", "in_progress"] } },
    actions: [{ type: "notify", properties: ["Assignee"] }, { type: "move_to_trash" }],
  });
  const viaMcp = await manage.createAutomation(ids.owner, tasks.id, toAutomationInput(mcpArgs));
  check(
    viaMcp.trigger.type === "date_passed" && viaMcp.trigger.date === due.id && viaMcp.trigger.days === 1 && viaMcp.trigger.status?.propertyId === status.id,
    "MCP input by names is stored by ids, the only status property taken when none is named",
    viaMcp.trigger,
  );
  const described = describeAutomation(await automationContext(ids.owner, tasks.id), viaMcp);
  check(
    described.trigger.summary === 'When 1 day has passed since "Due", for rows whose status is todo or in_progress' &&
      described.actions[1].summary === "Move the row to the trash",
    "MCP describes the trigger and the action in words",
    described,
  );
  const all = await manage.updateAutomation(ids.owner, viaMcp.id, { trigger: datePassed({ date: "created_time", status: { groups: ["todo", "in_progress", "done"] } }) });
  check(all.trigger.type === "date_passed" && all.trigger.date === "created_time" && all.trigger.status === null, "every status group is no condition; created_time is a date to count from");
  await manage.deleteAutomation(ids.owner, viaMcp.id);

  // ------------------------------------------------------------------ stale rows get a status
  const now = new Date();
  const [stale, doneStale, fresh, trashedStale, nameless] = await createRows(ids.owner, tasks.id, [
    { title: "Stale task", properties: { [status.id]: "Not started" } },
    { title: "Finished long ago", properties: { [status.id]: "Done" } },
    { title: "Fresh task", properties: { [status.id]: "In progress" } },
    { title: "Trashed stale task", properties: { [status.id]: "In progress" } },
    { title: "No status" },
  ]);
  const template = await createRowTemplate(owner, tasks.id, { title: "Template", properties: { [status.id]: "Not started" } });
  await archivePage(ids.owner, trashedStale.id);
  await backdate([stale.id, doneStale.id, trashedStale.id, nameless.id, template.id], 40, now);
  await backdate([fresh.id], 5, now);

  const watcher = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Status watcher",
    trigger: { type: "property_changed", property: "Status" },
    actions: [{ type: "set_properties", values: { Note: "watched" } }],
  });
  const staleInput = {
    name: "Mark stale",
    trigger: { type: "date_passed" as const, date: "last_edited_time", days: 30, status: { groups: ["todo", "in_progress"] } },
    actions: [{ type: "set_properties" as const, values: { Status: "Stale" } }],
  };
  check((await manage.previewDatePassed(ids.owner, tasks.id, staleInput.trigger)) === 2, "the dialog's count: two rows match now (the stale one and the one without a status)");
  const markStale = await manage.createAutomation(ids.owner, tasks.id, staleInput);
  check((await check1(markStale.id, now)) === 2, "the check queues a run for each");
  const staleRuns = await runsOf(markStale.id);
  check(
    staleRuns.length === 2 && new Set(staleRuns.map((r) => r.rowId)).size === 2 && staleRuns.every((r) => [stale.id, nameless.id].includes(r.rowId)),
    "…for the rows not edited for 30 days that aren't done: not the done one, the fresh one, the trashed one or the template",
    staleRuns,
  );
  check(staleRuns.every((r) => r.basis !== null && r.actorId === null && !r.created), "the runs carry the date they ran for, and no actor");
  await flushAutomations();
  const afterStale = await row(stale.id);
  check(afterStale.properties[status.id] === option("Stale") && afterStale.updatedBy === ids.owner, "the stale row gets the status, as whoever saved the automation", afterStale.properties);
  check((await runsOf(watcher.id)).length === 0, "an automation's change starts no other automation (no chains), timed ones included");
  const [history] = await manage.listAutomationRuns(ids.owner, markStale.id);
  check(history.event === "row.date_passed" && history.basis !== null && history.status === "done", "run history shows a date-passed run", history);

  check((await check1(markStale.id, now)) === 0, "checking again runs nothing");
  // The fresh row would go stale too in the month below: out of the way.
  await archivePage(ids.owner, fresh.id);
  const later = new Date(now.getTime() + 31 * DAY_MS);
  check((await check1(markStale.id, later)) === 0, "a month later, the automation's own edit doesn't count as one: no run again");
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");
  await updateRowProperties(ids.member, stale.id, { [title.id]: "touched" });
  check((await check1(markStale.id, new Date(now.getTime() + 10 * DAY_MS))) === 0, "edited since: not stale yet");
  const refired = await check1(markStale.id, later);
  const lastRun = (await runsOf(markStale.id)).at(-1);
  check(refired === 1 && lastRun?.rowId === stale.id, "stale again a month after someone's edit: it runs again, for that row only", { refired, lastRun });
  await flushAutomations();

  // ------------------------------------------------------------------ done rows go to the trash
  const [oldDone, recentDone, oldOpen] = await createRows(ids.owner, tasks.id, [
    { title: "Done three weeks ago", properties: { [status.id]: "Done", [completed.id]: dayBefore(now, 20) } },
    { title: "Done this week", properties: { [status.id]: "Done", [completed.id]: dayBefore(now, 3) } },
    { title: "Reopened", properties: { [status.id]: "In progress", [completed.id]: dayBefore(now, 20) } },
  ]);
  const doneTemplate = await createRowTemplate(owner, tasks.id, {
    title: "Done template",
    properties: { [status.id]: "Done", [completed.id]: dayBefore(now, 20) },
  });
  const cleanUp = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Clean up finished",
    trigger: { type: "date_passed", date: "Completed on", days: 14, status: { groups: ["done"] } },
    actions: [{ type: "move_to_trash" }],
  });
  check((await check1(cleanUp.id, now)) === 1, "done 14+ days ago: one row");
  await flushAutomations();
  check((await row(oldDone.id)).archivedAt !== null, "…moved to the trash");
  check((await row(recentDone.id)).archivedAt === null && (await row(oldOpen.id)).archivedAt === null, "rows done lately or not done stay");
  check((await row(doneTemplate.id)).archivedAt === null, "templates stay");
  const [trashRun] = await runsOf(cleanUp.id);
  check(trashRun.status === "done" && trashRun.steps[0].type === "move_to_trash" && trashRun.steps[0].status === "done", "the run says the row was trashed", trashRun);
  const [trashedEvent] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.trashed"), eq(auditEvent.targetId, oldDone.id)));
  check(
    trashedEvent?.actorKind === "automation" && trashedEvent.actorUserId === ids.owner && trashedEvent.actorVia === "Clean up finished",
    "the audit log has it, done by the automation for its person",
    trashedEvent,
  );

  await restorePage(ids.owner, oldDone.id);
  check((await check1(cleanUp.id, now)) === 0, "a restored row isn't trashed again for the same date");
  await updateRowProperties(ids.owner, oldDone.id, { [completed.id]: dayBefore(now, 15) });
  check((await check1(cleanUp.id, now)) === 1, "…but is with a new date that is past too");
  await flushAutomations();
  check((await row(oldDone.id)).archivedAt !== null, "…and goes back to the trash");

  // A change of what it counts from forgets what it ran for; other changes keep it.
  await manage.updateAutomation(ids.owner, cleanUp.id, { trigger: { type: "date_passed", date: "Completed on", days: 10, status: { groups: ["done"] } } });
  check((await db.select().from(automationFire).where(eq(automationFire.automationId, cleanUp.id))).length === 1, "changing the days keeps the rows it ran for");
  await manage.updateAutomation(ids.owner, cleanUp.id, { enabled: false, trigger: { type: "date_passed", date: "Due", days: 10 } });
  check((await db.select().from(automationFire).where(eq(automationFire.automationId, cleanUp.id))).length === 0, "counting from another date forgets them");

  // ------------------------------------------------------------------ the day a date comes
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");
  const [dueToday, dueTomorrow, dueDone] = await createRows(ids.owner, tasks.id, [
    { title: "Due today", properties: { [due.id]: serverDay(now), [assignee.id]: [ids.member], [status.id]: "In progress" } },
    { title: "Due tomorrow", properties: { [due.id]: serverDay(new Date(now.getTime() + DAY_MS)), [assignee.id]: [ids.member] } },
    { title: "Due today, done", properties: { [due.id]: serverDay(now), [assignee.id]: [ids.member], [status.id]: "Done" } },
  ]);
  const remind = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Due today",
    trigger: { type: "date_passed", date: "Due", days: 0, status: { groups: ["todo", "in_progress"] } },
    actions: [{ type: "notify", properties: ["Assignee"] }],
  });
  check((await check1(remind.id, now)) === 1, "the day a due date comes, for rows not done: one row");
  await flushAutomations();
  const told = await db.select().from(notification).where(and(eq(notification.automationId, remind.id), eq(notification.userId, ids.member)));
  check(told.length === 1 && told[0].pageId === dueToday.id && told[0].date === serverDay(now), "the row's person is told, with the date", told);
  const [item] = (await listInbox(ids.member, workspaceId)).filter((n) => n.kind === "automation");
  check(item?.reminderDate === serverDay(now) && item.automationName === "Due today", "the inbox knows it's a date that came", item);
  check(!told.some((n) => n.pageId === dueTomorrow.id || n.pageId === dueDone.id), "tomorrow's and done rows aren't");

  // ------------------------------------------------------------------ the database in the trash, the cap, the lock
  const batchDb = await createPage(owner, { workspaceId, kind: "database", title: "Many" });
  const total = DATE_PASSED_BATCH + 20;
  await createRows(ids.owner, batchDb.id, Array.from({ length: total }, (_, i) => ({ title: `row ${i}` })));
  const everyRow = await manage.createAutomation(ids.owner, batchDb.id, {
    name: "Every row",
    trigger: { type: "date_passed", date: "created_time", days: 0 },
    actions: [{ type: "notify", people: ["me"] }],
  });
  // Rows added just now: counted from a moment after.
  const afterRows = new Date();
  await archivePage(ids.owner, batchDb.id);
  check((await check1(everyRow.id, afterRows)) === 0, "a database in the trash runs nothing");
  await restorePage(ids.owner, batchDb.id);
  check((await check1(everyRow.id, afterRows)) === DATE_PASSED_BATCH, `rows that match when it's created run at the next check, ${DATE_PASSED_BATCH} at most`);
  const [a, b] = await Promise.all([check1(everyRow.id, afterRows), check1(everyRow.id, afterRows)]);
  check((a ?? 0) + (b ?? 0) === 20, "the rest at the checks after, even two at once", { a, b });
  const batchRuns = await runsOf(everyRow.id);
  check(batchRuns.length === total && new Set(batchRuns.map((r) => r.rowId)).size === total, "…each row once");
  check((await check1(everyRow.id, afterRows)) === 0, "…and then none");
  await db.delete(automationRun).where(eq(automationRun.automationId, everyRow.id));

  // ------------------------------------------------------------------ whose access, deleted properties
  await setPagePermission(ids.owner, tasks.id, ids.guest, "full");
  const [guestRow] = await createRows(ids.owner, tasks.id, [{ title: "Guest's row", properties: { [completed.id]: dayBefore(now, 30) } }]);
  const byGuest = await manage.createAutomation(ids.guest, tasks.id, {
    name: "Guest's cleanup",
    trigger: { type: "date_passed", date: "Completed on", days: 25 },
    actions: [{ type: "set_properties", values: { Note: "old" } }],
  });
  await setPagePermission(ids.owner, tasks.id, ids.guest, "edit");
  const lost = await check1(byGuest.id, now);
  check(lost === 0, "whoever saved it lost full access: nothing runs", { lost, runs: await runsOf(byGuest.id) });
  check((await manage.listAutomations(ids.owner, tasks.id)).find((x) => x.id === byGuest.id)?.checkError === "noAccess", "…and the automation says why");
  await setPagePermission(ids.owner, tasks.id, ids.guest, "full");
  check((await check1(byGuest.id, now)) === 1, "with full access back, it runs");
  await flushAutomations();
  check((await row(guestRow.id)).updatedBy === ids.guest, "…as them");
  check((await manage.listAutomations(ids.owner, tasks.id)).find((x) => x.id === byGuest.id)?.checkError === null, "…and the reason is gone");

  await deleteProperty(ids.owner, completed.id);
  await createRows(ids.owner, tasks.id, [{ title: "Another" }]);
  check((await check1(byGuest.id, now)) === 0, "its date property deleted: nothing runs");
  const [paused] = await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, byGuest.id));
  check(paused.checkError === "propertyDeleted", "…and the automation says why", paused);
  await restoreProperty(ids.owner, completed.id);
  await check1(byGuest.id, now);
  check((await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, byGuest.id)))[0].checkError === null, "restored, it carries on");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

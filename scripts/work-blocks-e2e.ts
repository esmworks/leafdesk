/**
 * End-to-end check of time planned for tasks on the Calendar (server/work-blocks.ts) against the
 * database: a person plans blocks for a row assigned to them and for a to-do of theirs, sees them
 * among their Calendar items for the days (titled by the task, where it is, opening it), moves
 * them and changes their length through the Calendar's move, and the To plan list adds up the
 * time planned per task. Lengths under 15 minutes or over 12 hours are refused. Nobody else sees
 * the blocks, nor moves or removes them; once the person can't open the task's page any more its
 * blocks drop out and can't be changed; a task in the trash hides its blocks and a restore brings
 * them back; a task done (a row's status, a ticked to-do) still shows its blocks, done.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/work-blocks-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { pageTask, user, workBlock, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { addProperty, createRows, getProperties, updateRowProperties } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { CalendarMoveError, calendarItems, moveCalendarItem } = await import("@/server/calendar");
const { createWorkBlock, deleteWorkBlock, tasksToPlan, WorkBlockError } = await import("@/server/work-blocks");
type CalendarItem = import("@/lib/calendar-items").CalendarItem;

const RUN = `work-blocks-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectLostAccess() {},
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

async function rejects(fn: () => Promise<unknown>, test: (error: unknown) => boolean, label: string) {
  try {
    await fn();
  } catch (error) {
    check(test(error), label, String(error));
    return;
  }
  check(false, label, "did not throw");
}
const blockError = (code: string) => (error: unknown) => error instanceof WorkBlockError && error.code === code;
const moveError = (code: string) => (error: unknown) => error instanceof CalendarMoveError && error.code === code;

// A week ahead, in UTC.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time: string) => new Date(`${day(offset)}T${time}:00.000Z`);
const range = { from: day(7), to: day(13), timeZone: "UTC" };

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const { owner, alice, bob } = ids;
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
  ]);

  // Tasks in the General teamspace: a row for alice, another that will be closed to her.
  const tasks = await createPage({ userId: owner }, { workspaceId, kind: "database", title: `${RUN} Tasks` });
  await addProperty(owner, tasks.id, { name: "Owner", type: "person" });
  const props = await getProperties(tasks.id);
  const status = props.find((p) => p.type === "status")!;
  const ownerProp = props.find((p) => p.name === "Owner")!.id;
  const option = (group: string) => status.options.options!.find((o) => o.group === group)!.id;
  const [offer, secret] = await createRows(owner, tasks.id, [
    { title: "Offer for X", properties: { [ownerProp]: [alice], [status.id]: option("todo") } },
    { title: "Secret task", properties: { [ownerProp]: [alice], [status.id]: option("todo") } },
  ]).then((rows) => rows.map((r) => r.id));

  // A to-do on alice's private page that mentions her (the index the page's save would write).
  const notes = await createPage({ userId: alice }, { workspaceId, teamspaceId: null, title: `${RUN} Notes` });
  const todoBlock = "todo-block-1";
  await db.insert(pageTask).values({ pageId: notes.id, blockId: todoBlock, userId: alice, text: "Call Ayşe" });
  const todoRef = { type: "pageTask" as const, pageId: notes.id, blockId: todoBlock };

  // ── The To plan list ────────────────────────────────────────────────────────────────────────
  const before = await tasksToPlan(alice, workspaceId);
  const keys = before.map((t) => t.key);
  check(keys.includes(offer) && keys.includes(`${notes.id}:${todoBlock}`), "the To plan list holds her open row and her to-do", keys);
  check(before.every((t) => t.plannedMinutes === 0), "…nothing planned yet");
  check(before.find((t) => t.key === offer)?.detail === `${RUN} Tasks` && before.find((t) => t.key === offer)?.href === `/w/${workspaceId}/p/${offer}`, "…with where each is and what it opens");

  // ── Planning ────────────────────────────────────────────────────────────────────────────────
  const tuesday = await createWorkBlock(alice, workspaceId, { type: "row", rowId: offer }, at(8, "10:00"), at(8, "12:00"));
  const thursday = await createWorkBlock(alice, workspaceId, { type: "row", rowId: offer }, at(10, "14:00"), at(10, "15:00"));
  const call = await createWorkBlock(alice, workspaceId, todoRef, at(9, "09:00"), at(9, "09:45"));
  const blocksOf = async (userId: string) => (await calendarItems(userId, workspaceId, range)).filter((i) => i.kind === "block");
  let mine = await blocksOf(alice);
  const byId = (items: CalendarItem[], id: string) => items.find((i) => i.id === `block:${id}`);
  check(mine.length === 3, "her blocks are among her Calendar items for the days", mine);
  const tue = byId(mine, tuesday)!;
  check(
    tue.title === "Offer for X" && tue.detail === `${RUN} Tasks` && tue.href === `/w/${workspaceId}/p/${offer}` && tue.date === `${at(8, "10:00").toISOString()}/${at(8, "12:00").toISOString()}`,
    "a row's block: its title, database, page and times",
    tue,
  );
  check(tue.moves?.allDay === false && tue.done === false && tue.task?.markable === true, "…moves on the hours only, open, and can mark the row done", tue);
  const todoItem = byId(mine, call)!;
  check(todoItem.title === "Call Ayşe" && todoItem.detail === `${RUN} Notes` && todoItem.href?.includes(todoBlock), "a to-do's block: its text, page and the to-do it opens", todoItem);
  check((await calendarItems(alice, workspaceId, { from: day(20), to: day(26), timeZone: "UTC" })).every((i) => i.kind !== "block"), "…only on the days of their times");
  let planned = new Map((await tasksToPlan(alice, workspaceId)).map((t) => [t.key, t.plannedMinutes]));
  check(planned.get(offer) === 180 && planned.get(`${notes.id}:${todoBlock}`) === 45, "the To plan list adds up the time planned per task", [...planned]);
  check((await tasksToPlan(alice, workspaceId)).find((t) => t.key === offer)!.plannedMinutes === 180, "…on the task itself");

  // ── Moving and resizing ─────────────────────────────────────────────────────────────────────
  await moveCalendarItem(alice, workspaceId, `block:${tuesday}`, `${at(8, "13:00").toISOString()}/${at(8, "15:00").toISOString()}`, "UTC");
  await moveCalendarItem(alice, workspaceId, `block:${thursday}`, `${at(10, "14:00").toISOString()}/${at(10, "16:30").toISOString()}`, "UTC");
  mine = await blocksOf(alice);
  check(byId(mine, tuesday)!.date === `${at(8, "13:00").toISOString()}/${at(8, "15:00").toISOString()}`, "a block moves to other times");
  check(byId(mine, thursday)!.date.endsWith(at(10, "16:30").toISOString()), "…and changes its length");
  planned = new Map((await tasksToPlan(alice, workspaceId)).map((t) => [t.key, t.plannedMinutes]));
  check(planned.get(offer) === 270, "…which the total follows", [...planned]);
  await rejects(
    () => moveCalendarItem(alice, workspaceId, `block:${tuesday}`, at(8, "13:00").toISOString(), "UTC"),
    moveError("fixed"),
    "a block needs an end: a bare time is refused",
  );
  await rejects(() => moveCalendarItem(alice, workspaceId, `block:${tuesday}`, day(8), "UTC"), moveError("fixed"), "…and so is a whole day");

  // ── Length limits ───────────────────────────────────────────────────────────────────────────
  await rejects(() => createWorkBlock(alice, workspaceId, { type: "row", rowId: offer }, at(8, "10:00"), at(8, "10:10")), blockError("tooShort"), "a block under 15 minutes is refused");
  await rejects(() => createWorkBlock(alice, workspaceId, { type: "row", rowId: offer }, at(8, "08:00"), at(8, "20:15")), blockError("tooLong"), "…and one over 12 hours");
  await rejects(
    () => moveCalendarItem(alice, workspaceId, `block:${tuesday}`, `${at(8, "13:00").toISOString()}/${at(8, "13:05").toISOString()}`, "UTC"),
    moveError("fixed"),
    "…and so is shortening one under 15 minutes",
  );
  let constraint = false;
  try {
    await db.insert(workBlock).values({ userId: alice, workspaceId, pageId: offer, startsAt: at(8, "10:00"), endsAt: at(8, "10:05") });
  } catch {
    constraint = true;
  }
  check(constraint, "…which the database holds to as well");
  const midnight = await createWorkBlock(alice, workspaceId, { type: "row", rowId: offer }, at(11, "23:00"), at(12, "01:00"));
  check(byId(await blocksOf(alice), midnight), "a block may run past midnight");
  await deleteWorkBlock(alice, workspaceId, midnight);

  // ── Not hers to see or change ───────────────────────────────────────────────────────────────
  check((await blocksOf(bob)).length === 0, "nobody else sees her blocks");
  check((await tasksToPlan(bob, workspaceId)).every((t) => t.plannedMinutes === 0), "…nor her planned time");
  await rejects(() => moveCalendarItem(bob, workspaceId, `block:${tuesday}`, `${at(8, "16:00").toISOString()}/${at(8, "17:00").toISOString()}`, "UTC"), moveError("notFound"), "…nor moves them");
  await rejects(() => deleteWorkBlock(bob, workspaceId, call), blockError("notFound"), "…nor removes them");
  await rejects(() => createWorkBlock(bob, workspaceId, todoRef, at(8, "10:00"), at(8, "11:00")), blockError("noAccess"), "a page he can't open can't be planned for");
  await rejects(() => createWorkBlock(bob, workspaceId, { type: "pageTask", pageId: offer, blockId: todoBlock }, at(8, "10:00"), at(8, "11:00")), blockError("notTask"), "…nor a to-do that isn't his");
  await rejects(() => createWorkBlock(alice, workspaceId, { type: "row", rowId: notes.id }, at(8, "10:00"), at(8, "11:00")), blockError("notTask"), "a page that isn't a row isn't a task to plan");
  check((await db.select().from(workBlock).where(eq(workBlock.userId, bob))).length === 0, "nothing was written for him");

  // ── Losing access ───────────────────────────────────────────────────────────────────────────
  const hidden = await createWorkBlock(alice, workspaceId, { type: "row", rowId: secret }, at(9, "15:00"), at(9, "16:00"));
  check(byId(await blocksOf(alice), hidden), "a block for another row shows");
  await setPagePermission(owner, secret, owner, "full");
  await setPagePermission(owner, secret, null, "none");
  check(!byId(await blocksOf(alice), hidden), "…and drops out once she can't open the row");
  await rejects(() => moveCalendarItem(alice, workspaceId, `block:${hidden}`, `${at(9, "16:00").toISOString()}/${at(9, "17:00").toISOString()}`, "UTC"), moveError("noAccess"), "…nor can she move it");
  await rejects(() => deleteWorkBlock(alice, workspaceId, hidden), blockError("noAccess"), "…or remove it");
  await rejects(() => createWorkBlock(alice, workspaceId, { type: "row", rowId: secret }, at(9, "10:00"), at(9, "11:00")), blockError("noAccess"), "…or plan more for it");

  // ── The trash ───────────────────────────────────────────────────────────────────────────────
  await archivePage(owner, offer);
  mine = await blocksOf(alice);
  check(!byId(mine, tuesday) && !byId(mine, thursday) && byId(mine, call), "a row in the trash hides its blocks, others stay");
  check(!(await tasksToPlan(alice, workspaceId)).some((t) => t.key === offer), "…and leaves the To plan list");
  check((await db.select().from(workBlock).where(eq(workBlock.pageId, offer))).length === 2, "…without deleting them");
  await rejects(() => moveCalendarItem(alice, workspaceId, `block:${tuesday}`, `${at(8, "16:00").toISOString()}/${at(8, "17:00").toISOString()}`, "UTC"), moveError("notFound"), "…which can't be moved meanwhile");
  await restorePage(owner, offer);
  mine = await blocksOf(alice);
  check(byId(mine, tuesday) && byId(mine, thursday), "restoring it brings them back");

  // ── Done tasks ──────────────────────────────────────────────────────────────────────────────
  await updateRowProperties(alice, offer, { [status.id]: option("done") });
  mine = await blocksOf(alice);
  check(byId(mine, tuesday)?.done === true && byId(mine, tuesday)?.task?.markable === false, "a row marked done still shows its blocks, done", byId(mine, tuesday));
  check(!(await tasksToPlan(alice, workspaceId)).some((t) => t.key === offer), "…and leaves the To plan list");
  // Ticking the to-do takes it out of the index (the page's save does).
  await db.delete(pageTask).where(and(eq(pageTask.pageId, notes.id), eq(pageTask.blockId, todoBlock)));
  const ticked = byId(await blocksOf(alice), call);
  check(ticked?.done === true && ticked.title === "Call Ayşe", "a ticked to-do's block shows done, with the title it was planned with", ticked);

  // ── Removing ────────────────────────────────────────────────────────────────────────────────
  await deleteWorkBlock(alice, workspaceId, call);
  check(!byId(await blocksOf(alice), call), "she removes a block");
  await rejects(() => deleteWorkBlock(alice, workspaceId, call), blockError("notFound"), "…once");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

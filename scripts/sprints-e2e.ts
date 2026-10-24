/**
 * End-to-end check of sprints against the database: turning them on for a task database (a
 * sprints database beside it with the first sprint current and the next one next, the relation,
 * the rollup and the views of the current sprint, planning and the backlog), completing a sprint
 * from either database (unfinished tasks carried over, states moved on, a new next sprint), the
 * current sprint's view following without its filter changing, refusals (no access, no current
 * sprint, the sprints database itself), the REST operation, copies, and turning sprints off and on
 * again. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/sprints-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty, createRows, getProperties, listRows, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { duplicatePage } = await import("@/server/duplicate");
const { completeSprint, getSprints, setSprints } = await import("@/server/sprints");
const ops = await import("@/server/operations");
const { AccessError } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");
const { sprintProperty } = await import("@/lib/sprints");

const RUN = `sprints-e2e-${Date.now().toString(36)}`;

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

async function rejects(fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return code ? error instanceof PropertyValueError && error.code === code : error instanceof AccessError;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values(userIds.map((userId) => ({ workspaceId, userId, role: userId === ids.owner ? ("owner" as const) : ("member" as const) })));
  const actor = { userId: ids.owner };
  const project = await createPage(actor, { workspaceId, title: "Project" });
  await setPagePermission(ids.owner, project.id, ids.owner, "full");
  await setPagePermission(ids.owner, project.id, null, "none");
  await setPagePermission(ids.owner, project.id, ids.member, "edit");
  await setPagePermission(ids.owner, project.id, ids.viewer, "view");
  // A task database with the starter Status (Not started / In progress / Done).
  const tasks = await createPage(actor, { workspaceId, parentId: project.id, kind: "database", title: "Tasks" });
  const status = (await getProperties(tasks.id)).find((p) => p.type === "status")!;
  const option = (name: string) => status.options.options!.find((o) => o.name === name)!.id;
  const [t1, t2, t3, , t5] = await createRows(ids.owner, tasks.id, [
    { title: "Write spec", properties: { [status.id]: option("Not started") } },
    { title: "Ship login", properties: { [status.id]: option("Done") } },
    { title: "Fix search", properties: { [status.id]: option("In progress") } },
    { title: "Someday", properties: { [status.id]: option("Not started") } },
    { title: "Locked away", properties: { [status.id]: option("Not started") } },
  ]);

  // Turning on: a sprints database beside the tasks, the first sprint current, the next one next
  check(await rejects(() => setSprints({ userId: ids.viewer }, tasks.id, { on: true, weeks: 2 })), "someone who may only view the tasks can't turn sprints on");
  check(await rejects(() => setSprints(actor, tasks.id, { on: true, weeks: 5 }), "invalidSprints"), "a sprint is at most 4 weeks long");
  const on = await setSprints(actor, tasks.id, { on: true, weeks: 2, start: "2026-10-26" });
  check(on.side === "tasks" && on.on && on.sprintsDatabase !== null, "sprints are on", on);
  const sprintsId = on.sprintsDatabase!.id;
  const [sprintsDb] = await db.select().from(page).where(eq(page.id, sprintsId));
  check(sprintsDb.parentId === project.id && sprintsDb.title === "Sprints" && sprintsDb.kind === "database", "the Sprints database sits beside the tasks", sprintsDb);
  let taskProps = await getProperties(tasks.id);
  const sprint = sprintProperty(taskProps)!;
  const config = sprint.options.relation!.sprints!;
  const sprintProps = await getProperties(sprintsId);
  const tasksProp = sprintProps.find((p) => p.id === sprint.options.relation!.pairedPropertyId)!;
  const rollup = taskProps.find((p) => p.type === "rollup")!;
  check(
    sprint.name === "Sprint" && tasksProp?.name === "Tasks" && rollup?.name === "Sprint state" && rollup.options.pageVisibility === "hide" && config.weeks === 2,
    "tasks get a two-way Sprint relation and a hidden Sprint state rollup",
    taskProps.map((p) => [p.name, p.type, p.options]),
  );
  check(
    sprintProps.map((p) => `${p.name}:${p.type}`).join() === "Dates:date,State:select,Tasks:relation",
    "the sprints database has dates, a state and the tasks",
    sprintProps.map((p) => p.name),
  );
  const sprintRow = async (id: string) => (await db.select().from(page).where(eq(page.id, id)))[0];
  const sprintsNow = async () =>
    (await db.select().from(page).where(and(eq(page.parentId, sprintsId), eq(page.isTemplate, false)))).sort((a, b) => a.position - b.position);
  const stateName = (row: { properties: Record<string, unknown> }) =>
    sprintProps.find((p) => p.id === config.statePropertyId)!.options.options!.find((o) => o.id === row.properties[config.statePropertyId])?.name;
  let sprints = await sprintsNow();
  check(
    sprints.map((s) => `${s.title}|${stateName(s)}|${s.properties[config.datesPropertyId]}`).join() ===
      "Sprint 1|Current|2026-10-26/2026-11-08,Sprint 2|Next|2026-11-09/2026-11-22",
    "Sprint 1 is current for two weeks from the day given, Sprint 2 next after it",
    sprints.map((s) => [s.title, stateName(s), s.properties[config.datesPropertyId]]),
  );
  const [s1, s2] = sprints;
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, tasks.id));
  const view = (name: string) => views.find((v) => v.name === name)!;
  check(
    view("Current sprint")?.type === "board" &&
      view("Current sprint").id === config.boardViewId &&
      view("Current sprint").config.groupBy === status.id &&
      view("Sprint planning")?.config.groupBy === sprint.id &&
      view("Backlog")?.type === "table",
    "the tasks get the current sprint's board by status, sprint planning grouped by sprint and the backlog",
    views.map((v) => [v.name, v.type, v.config]),
  );
  const again = await setSprints(actor, tasks.id, { on: true, weeks: 3 });
  check(
    again.side === "tasks" && again.on && again.weeks === 3 && (await sprintsNow()).length === 2 && (await getProperties(tasks.id)).length === taskProps.length,
    "turning them on again only changes the length of new sprints",
  );
  await setSprints(actor, tasks.id, { on: true, weeks: 2 });
  check(await rejects(() => setSprints(actor, sprintsId, { on: true, weeks: 2 }), "sprintsDatabase"), "the sprints database can't get sprints of its own");
  const fromSprints = await getSprints(ids.owner, sprintsId);
  check(fromSprints.side === "sprints" && fromSprints.tasksDatabase.id === tasks.id, "the sprints database knows whose sprints it holds");

  // Planning: tasks in Sprint 1, one in the backlog
  for (const t of [t1, t2, t3, t5]) await updateRowProperties(ids.owner, t.id, { [sprint.id]: [s1.id] });
  const titles = async (name: string, as = ids.owner) => (await listRows(as, tasks.id, view(name).config)).map((r) => r.title).sort().join();
  check((await titles("Current sprint")) === "Fix search,Locked away,Ship login,Write spec", "the current sprint's board shows Sprint 1's tasks", await titles("Current sprint"));
  check((await titles("Backlog")) === "Someday", "the backlog shows the task without a sprint");
  check((await sprintRow(s1.id)).properties[tasksProp.id] instanceof Array, "Sprint 1 lists its tasks");

  // Access: completing needs edit access to both databases; tasks one may not change stay
  check(await rejects(() => completeSprint(ids.viewer, tasks.id)), "someone who may only view can't complete a sprint");
  await setPagePermission(ids.owner, t5.id, ids.member, "view");
  await setPagePermission(ids.owner, sprintsId, ids.member, "view");
  check(await rejects(() => completeSprint(ids.member, tasks.id)), "editing the tasks isn't enough: the sprints need edit access too");
  check(stateName(await sprintRow(s1.id)) === "Current", "a refused completion changes nothing");
  await setPagePermission(ids.owner, sprintsId, ids.member, "edit");

  // A dry run says what would change and changes nothing
  const preview = await completeSprint(ids.member, tasks.id, { dryRun: true });
  check(
    preview.completed.id === s1.id && preview.current.id === s2.id && !preview.current.created && preview.next.created && preview.next.title === "Sprint 3" && preview.moved === 2 && preview.skipped === 1,
    "a dry run names the sprints and counts the tasks that move (and the one that can't)",
    preview,
  );
  check(stateName(await sprintRow(s1.id)) === "Current" && (await sprintsNow()).length === 2, "a dry run changes nothing");

  // Completing: Sprint 1 completed, Sprint 2 current, Sprint 3 next, unfinished tasks carried over
  const done = await completeSprint(ids.member, tasks.id);
  sprints = await sprintsNow();
  const s3 = sprints.find((s) => s.title === "Sprint 3");
  check(
    sprints.map((s) => `${s.title}|${stateName(s)}`).join() === "Sprint 1|Completed,Sprint 2|Current,Sprint 3|Next" &&
      s3?.properties[config.datesPropertyId] === "2026-11-23/2026-12-06" &&
      done.next.id === s3.id,
    "Sprint 1 is completed, Sprint 2 current, and a new Sprint 3 of two weeks is next",
    sprints.map((s) => [s.title, stateName(s), s.properties[config.datesPropertyId]]),
  );
  const sprintOf = async (id: string) => (await sprintRow(id)).properties[sprint.id];
  check(
    JSON.stringify(await sprintOf(t1.id)) === JSON.stringify([s2.id]) &&
      JSON.stringify(await sprintOf(t3.id)) === JSON.stringify([s2.id]) &&
      JSON.stringify(await sprintOf(t2.id)) === JSON.stringify([s1.id]) &&
      JSON.stringify(await sprintOf(t5.id)) === JSON.stringify([s1.id]),
    "unfinished tasks move to Sprint 2; the done task and the one the member may not change stay",
  );
  check(
    JSON.stringify([...((await sprintRow(s1.id)).properties[tasksProp.id] as string[])].sort()) === JSON.stringify([t2.id, t5.id].sort()) &&
      JSON.stringify([...((await sprintRow(s2.id)).properties[tasksProp.id] as string[])].sort()) === JSON.stringify([t1.id, t3.id].sort()),
    "each sprint lists the tasks it now holds",
  );
  const [boardAfter] = await db.select().from(databaseView).where(eq(databaseView.id, config.boardViewId!));
  check(
    (await titles("Current sprint")) === "Fix search,Write spec" && JSON.stringify(boardAfter.config.filters) === JSON.stringify(view("Current sprint").config.filters),
    "the current sprint's board follows Sprint 2 without its filter changing",
    await titles("Current sprint"),
  );
  check(!(await titles("Sprint planning")).includes("Ship login"), "planning leaves out the completed sprint's tasks");

  // From the sprints database, through the REST operation: Sprint 2 completed, Sprint 3 current
  await updateRowProperties(ids.owner, t3.id, { [status.id]: option("Done") });
  const rest = await ops.completeSprint({ userId: ids.owner, actor }, { database_id: sprintsId, dry_run: false });
  sprints = await sprintsNow();
  check(
    rest.completed.id === s2.id && rest.current.id === s3?.id && rest.next.title === "Sprint 4" && rest.next.created === true && rest.moved_tasks === 1 &&
      sprints.map((s) => stateName(s)).join() === "Completed,Completed,Current,Next",
    "completing from the sprints database moves on the same way",
    rest,
  );
  check(JSON.stringify(await sprintOf(t1.id)) === JSON.stringify([s3!.id]), "the task left unfinished again moves on to Sprint 3");

  // No current sprint: nothing to complete
  const stateId = config.statePropertyId;
  for (const s of sprints) await updateRowProperties(ids.owner, s.id, { [stateId]: config.states.completed });
  check(await rejects(() => completeSprint(ids.owner, tasks.id), "noCurrentSprint"), "without a current sprint there's nothing to complete");
  await updateRowProperties(ids.owner, sprints[3].id, { [stateId]: config.states.current });

  // A copy of the project keeps sprints, kept in the copied sprints database
  const copy = await duplicatePage(actor, project.id, " (copy)");
  const copied = await db.select().from(page).where(eq(page.parentId, copy.id));
  const copiedTasks = copied.find((p) => p.title === "Tasks")!;
  const copiedSprints = copied.find((p) => p.title === "Sprints")!;
  const copyInfo = await getSprints(ids.owner, copiedTasks.id);
  check(
    copyInfo.side === "tasks" && copyInfo.on && copyInfo.sprintsDatabase?.id === copiedSprints.id && copyInfo.current?.title === "Sprint 4" &&
      copyInfo.boardViewId !== null && copyInfo.boardViewId !== config.boardViewId,
    "a copy of the project has sprints in its own sprints database, with its own board",
    copyInfo,
  );

  // Off keeps everything; on again picks the same sprints up
  const off = await setSprints(actor, tasks.id, { on: false });
  taskProps = await getProperties(tasks.id);
  check(
    off.side === "tasks" && !off.on && off.again?.id === sprintsId && !sprintProperty(taskProps) && taskProps.some((p) => p.id === sprint.id) && JSON.stringify(await sprintOf(t1.id)) === JSON.stringify([s3!.id]),
    "turning sprints off keeps the relation, its links and the sprints database",
    off,
  );
  check(await rejects(() => completeSprint(ids.owner, tasks.id), "sprintsOff"), "with sprints off there's no sprint to complete");
  const back = await setSprints(actor, tasks.id, { on: true, weeks: 1 });
  const databasesNow = await db.select({ id: page.id }).from(page).where(and(eq(page.parentId, project.id), eq(page.kind, "database")));
  check(
    back.side === "tasks" && back.on && back.sprintsDatabase?.id === sprintsId && back.weeks === 1 && databasesNow.length === 2,
    "turning them on again picks the same sprints database up, with the new length",
    back,
  );

  // A task database without a status gets one
  const bare = await createPage(actor, { workspaceId, parentId: project.id, kind: "database", title: "Ideas", seedProperties: false });
  await addProperty(ids.owner, bare.id, { name: "Notes", type: "text" });
  await setSprints(actor, bare.id, { on: true, weeks: 1, start: "2026-11-02" });
  const bareProps = await getProperties(bare.id);
  check(bareProps.some((p) => p.type === "status") && sprintProperty(bareProps), "a task database without a status gets one with sprints");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

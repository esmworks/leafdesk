/**
 * Sprints for a task database (see lib/sprints): turning them on makes a sprints database beside
 * it, links the tasks to it and adds views of the current sprint, of planning and of the backlog;
 * completing a sprint moves the sprints on and carries unfinished tasks over. Everything runs as
 * the person, with their access to both databases.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, databaseView, page } from "@/db/schema";
import type { PropertyOptions, RelationConfig, SprintConfig, SprintState, ViewConfig } from "@/db/schema/app";
import { loadMessages } from "@/i18n/messages";
import { isDay } from "@/lib/date-value";
import { isDoneStatus, PropertyValueError } from "@/lib/properties";
import {
  isSprintWeeks,
  planSprintCompletion,
  sortSprints,
  sprintAfter,
  sprintDates,
  sprintDays,
  sprintProperty,
  sprintStateOf,
  tasksToMove,
  type SprintRow,
} from "@/lib/sprints";
import { dayString } from "@/lib/time-zone";
import { AccessError, accessRank, hasLevel, levelFromRank } from "@/server/access";
import { recordAudit } from "@/server/audit";
import type { WriteActor } from "@/server/collab/bridge";
import {
  addProperty,
  addView,
  afterRowWrites,
  assertUnlocked,
  createRows,
  getProperties,
  mergedProperties,
  notifyRows,
  notifySchema,
  notifyTree,
  requireDatabase,
  updateView,
  type DatabaseProperty,
} from "@/server/databases";
import { discard } from "@/server/import/markdown";
import { savedLocale } from "@/server/mail/locale";
import { assertNestable } from "@/server/page-depth";
import { createPage, savedSeedNames } from "@/server/pages";
import { propertyAccessFor } from "@/server/property-access";
import { rowChanged } from "@/server/row-events";

type SprintNames = Awaited<ReturnType<typeof loadMessages>>["database"]["sprints"]["names"];

/** What sprints and their views are called, in the person's language (English when none is saved). */
async function sprintNames(userId: string): Promise<SprintNames> {
  return (await loadMessages((await savedLocale(userId)) ?? "en")).database.sprints.names;
}

const refuse = (message: string, code: "sprintsOff" | "sprintsDatabase" | "noCurrentSprint" | "invalidSprints") =>
  new PropertyValueError(message, code);

/** Today in UTC (YYYY-MM-DD). */
const today = () => dayString(Math.floor(Date.now() / 86_400_000));

/**
 * The sprints a database takes part in, from either side: the task database's sprint property and
 * its config, the two databases, and the property listing each sprint's tasks (the other side of
 * the relation, when it has one). Null when sprints are off for it.
 */
async function sprintSetup(databaseId: string) {
  const properties = await getProperties(databaseId);
  let prop = sprintProperty(properties);
  if (!prop) {
    const paired = properties.flatMap((p) => (p.type === "relation" && p.options.relation?.pairedPropertyId ? [p.options.relation.pairedPropertyId] : []));
    const others = paired.length
      ? await db
          .select()
          .from(databaseProperty)
          .where(and(inArray(databaseProperty.id, paired), isNull(databaseProperty.deletedAt)))
      : [];
    prop = sprintProperty(others.filter((p) => p.options.relation?.databaseId === databaseId));
  }
  if (!prop) return null;
  const relation = prop.options.relation!;
  return {
    property: prop,
    config: relation.sprints!,
    tasksDatabaseId: prop.databaseId,
    sprintsDatabaseId: relation.databaseId,
    tasksPropertyId: relation.pairedPropertyId ?? null,
  };
}

/** Whether a sprints config still fits the sprints database's properties. */
function fits(config: SprintConfig, properties: DatabaseProperty[]) {
  const state = properties.find((p) => p.id === config.statePropertyId && p.type === "select");
  const dates = properties.some((p) => p.id === config.datesPropertyId && p.type === "date");
  const options = new Set((state?.options.options ?? []).map((o) => o.id));
  return Boolean(state && dates && Object.values(config.states).every((id) => options.has(id)));
}

/** The status telling finished tasks from the others: the current sprint board's columns, else the first status. */
async function taskStatus(tasksDatabaseId: string, config: SprintConfig, properties: DatabaseProperty[]) {
  const [board] = config.boardViewId
    ? await db.select({ config: databaseView.config }).from(databaseView).where(and(eq(databaseView.id, config.boardViewId), isNull(databaseView.deletedAt)))
    : [];
  return (
    properties.find((p) => p.id === board?.config.groupBy && p.type === "status") ??
    properties.find((p) => p.type === "status" && p.databaseId === tasksDatabaseId) ??
    null
  );
}

type SprintSummary = { id: string; title: string; dates: string | null };

export type SprintsInfo =
  /** The database holds the sprints of `tasksDatabase`. */
  | { side: "sprints"; tasksDatabase: { id: string; title: string } }
  | {
      side: "tasks";
      on: true;
      weeks: number;
      /** Null while the sprints database is in the trash or no longer laid out as sprints. */
      sprintsDatabase: { id: string; title: string } | null;
      current: SprintSummary | null;
      next: SprintSummary | null;
      boardViewId: string | null;
    }
  /** `again`: the sprints database used before, which turning sprints on picks up again. */
  | { side: "tasks"; on: false; again: { id: string; title: string } | null };

/** A live database's id and title, or null. */
async function liveDatabase(id: string) {
  const [found] = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(and(eq(page.id, id), eq(page.kind, "database"), isNull(page.archivedAt)));
  return found ?? null;
}

/** The sprints database a task database used before sprints were turned off, while it is still fit to use. */
async function earlierSprints(properties: DatabaseProperty[]) {
  for (const prop of properties) {
    const relation = prop.type === "relation" ? prop.options.relation : undefined;
    if (!relation?.sprints || relation.role || relation.databaseId === prop.databaseId) continue;
    const database = await liveDatabase(relation.databaseId);
    if (database && fits(relation.sprints, await getProperties(database.id))) return { prop, database };
  }
  return null;
}

/** Sprints as the database's settings show them (see SprintsInfo). Needs view access. */
export async function getSprints(userId: string, databaseId: string): Promise<SprintsInfo> {
  await requireDatabase(userId, databaseId, "view");
  const setup = await sprintSetup(databaseId);
  if (setup && setup.sprintsDatabaseId === databaseId) {
    const [tasks] = await db.select({ id: page.id, title: page.title }).from(page).where(eq(page.id, setup.tasksDatabaseId));
    return { side: "sprints", tasksDatabase: tasks };
  }
  if (!setup) {
    const earlier = await earlierSprints(await getProperties(databaseId));
    return { side: "tasks", on: false, again: earlier?.database ?? null };
  }
  const { config } = setup;
  const database = await liveDatabase(setup.sprintsDatabaseId);
  const usable = database && fits(config, await getProperties(database.id));
  const sprints = usable ? sortSprints(await sprintRows(userId, database.id), config) : [];
  const summary = (state: SprintState): SprintSummary | null => {
    const row = sprints.find((r) => sprintStateOf(r, config) === state);
    const dates = row?.properties[config.datesPropertyId];
    return row ? { id: row.id, title: row.title, dates: typeof dates === "string" ? dates : null } : null;
  };
  return {
    side: "tasks",
    on: true,
    weeks: config.weeks,
    sprintsDatabase: usable ? database : null,
    current: summary("current"),
    next: summary("next"),
    boardViewId: config.boardViewId ?? null,
  };
}

/** The sprints the person can see. */
async function sprintRows(userId: string, sprintsDatabaseId: string): Promise<SprintRow[]> {
  const rows = await db
    .select({ id: page.id, title: page.title, properties: page.properties, position: page.position, level: accessRank(userId, sql`${page.id}`) })
    .from(page)
    .where(and(eq(page.parentId, sprintsDatabaseId), eq(page.isTemplate, false), isNull(page.archivedAt)));
  return rows.filter((r) => hasLevel(levelFromRank(r.level), "view"));
}

export type SprintsInput = { on: false } | { on: true; weeks: number; start?: string };

/**
 * Turns sprints on or off for a task database, or changes how long new sprints are. Off keeps the
 * sprints database, its sprints, the tasks' links and the views; only the relation stops standing
 * for sprints, and turning them on again picks the same sprints database up. On for the first time
 * (see setUpSprints) makes it. Needs edit access to the task database, unlocked.
 */
export async function setSprints(actor: WriteActor, databaseId: string, input: SprintsInput): Promise<SprintsInfo> {
  const { userId } = actor;
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  const setup = await sprintSetup(databaseId);
  if (setup && setup.sprintsDatabaseId === databaseId) throw refuse("This database holds the sprints of another database", "sprintsDatabase");
  const setRelation = async (prop: DatabaseProperty, relation: RelationConfig) => {
    await db
      .update(databaseProperty)
      .set({ options: { ...prop.options, relation } })
      .where(eq(databaseProperty.id, prop.id));
  };

  if (!input.on) {
    if (setup) {
      const { role: _role, ...relation } = setup.property.options.relation!;
      await setRelation(setup.property, relation);
      notifySchema(databaseId);
    }
    return getSprints(userId, databaseId);
  }
  if (!isSprintWeeks(input.weeks)) throw refuse("A sprint is 1 to 4 weeks long", "invalidSprints");
  if (input.start !== undefined && !isDay(input.start)) throw refuse("A sprint starts on a day (YYYY-MM-DD)", "invalidSprints");

  const properties = await getProperties(databaseId);
  const earlier = setup ? null : await earlierSprints(properties);
  const kept = setup?.property ?? earlier?.prop;
  if (kept) {
    // Already on, or on before: the same sprints, from now on as long as asked.
    const relation = kept.options.relation!;
    await setRelation(kept, { ...relation, role: "sprint", sprints: { ...relation.sprints!, weeks: input.weeks } });
    notifySchema(databaseId);
  } else {
    await setUpSprints(actor, database, properties, input.weeks, input.start ?? today());
  }
  return getSprints(userId, databaseId);
}

/**
 * Sets sprints up for the first time, all of it or nothing: a sprints database beside the task
 * database (dates, a state, the first sprint current and the one after it next, a table and a
 * board), and on the task database a two-way relation to it, a rollup of each task's sprint's
 * state, a status when it has none, and three views: the current sprint's board by status (its
 * filter follows whichever sprint is current, by the rollup), planning grouped by sprint with the
 * backlog first, and the backlog. When a step fails, what was made is taken back.
 */
async function setUpSprints(
  actor: WriteActor,
  tasks: { id: string; workspaceId: string; parentId: string | null; teamspaceId: string | null },
  properties: DatabaseProperty[],
  weeks: number,
  start: string,
) {
  const { userId } = actor;
  const [names, seed] = await Promise.all([sprintNames(userId), savedSeedNames(userId)]);
  const madeProperties: string[] = [];
  const madeViews: string[] = [];
  let sprintsId: string | null = null;
  try {
    const sprints = await createPage(
      actor,
      {
        workspaceId: tasks.workspaceId,
        ...(tasks.parentId ? { parentId: tasks.parentId } : { teamspaceId: tasks.teamspaceId }),
        kind: "database",
        title: names.database,
        icon: "🏁",
        seedNames: seed,
        seedProperties: false,
      },
      { audit: false },
    );
    sprintsId = sprints.id;
    const dates = await addProperty(userId, sprints.id, { name: names.dates, type: "date" });
    const state = await addProperty(userId, sprints.id, {
      name: names.state,
      type: "select",
      options: [
        { name: names.current, color: "green" },
        { name: names.next, color: "blue" },
        { name: names.future, color: "gray" },
        { name: names.completed, color: "purple" },
      ],
    });
    const option = (name: string) => state.options.options!.find((o) => o.name === name)!.id;
    const states: Record<SprintState, string> = {
      current: option(names.current),
      next: option(names.next),
      future: option(names.future),
      completed: option(names.completed),
    };
    const title = (n: number) => names.sprintTitle.replace("{number}", String(n));
    const first = sprintDates(start, weeks);
    await createRows(userId, sprints.id, [
      { title: title(1), properties: { [state.id]: states.current, [dates.id]: first } },
      { title: title(2), properties: { [state.id]: states.next, [dates.id]: sprintAfter(sprintDays(first), weeks, start) } },
    ]);
    const [starter] = await db.select({ id: databaseView.id }).from(databaseView).where(eq(databaseView.databaseId, sprints.id));
    if (starter) await updateView(userId, starter.id, { name: names.allView, config: { sorts: [{ propertyId: dates.id, direction: "asc" }] } });
    await addView(userId, sprints.id, { name: names.boardView, type: "board", config: { groupBy: state.id } });

    // The task database: what tasks are done by, their sprint, and their sprint's state.
    let status = properties.find((p) => p.type === "status");
    if (!status) {
      status = await addProperty(userId, tasks.id, { name: seed.status, type: "status", options: [seed.notStarted, seed.inProgress, seed.done] });
      madeProperties.push(status.id);
    }
    const sprint = await addProperty(userId, tasks.id, {
      name: names.sprint,
      type: "relation",
      relation: { databaseId: sprints.id, twoWay: true, pairedName: names.tasks },
    });
    madeProperties.push(sprint.id);
    const rollup = await addProperty(userId, tasks.id, {
      name: names.sprintState,
      type: "rollup",
      rollup: { relationPropertyId: sprint.id, targetPropertyId: state.id, function: "show_original" },
    });
    madeProperties.push(rollup.id);
    // Views filter by it; row pages don't need to show it beside the sprint.
    await db
      .update(databaseProperty)
      .set({ options: { ...rollup.options, pageVisibility: "hide" } satisfies PropertyOptions })
      .where(eq(databaseProperty.id, rollup.id));

    const hidden = [rollup.id];
    const view = async (name: string, type: "board" | "table", config: ViewConfig) => {
      const made = await addView(userId, tasks.id, { name, type, config: { ...config, hidden } });
      madeViews.push(made.id);
      return made;
    };
    // By the sprint's state rather than the sprint itself, so the view follows the current sprint.
    const board = await view(names.currentView, "board", {
      groupBy: status.id,
      filters: [{ propertyId: rollup.id, op: "contains", value: names.current }],
    });
    await view(names.planningView, "table", {
      groupBy: sprint.id,
      filters: [{ propertyId: rollup.id, op: "does_not_contain", value: names.completed }],
    });
    await view(names.backlogView, "table", { filters: [{ propertyId: sprint.id, op: "is_empty" }] });

    const relation = (await getProperties(tasks.id)).find((p) => p.id === sprint.id)!.options.relation!;
    await db
      .update(databaseProperty)
      .set({
        options: {
          ...sprint.options,
          relation: {
            ...relation,
            role: "sprint",
            sprints: { datesPropertyId: dates.id, statePropertyId: state.id, states, weeks, boardViewId: board.id },
          },
        },
      })
      .where(eq(databaseProperty.id, sprint.id));
  } catch (error) {
    if (madeViews.length) await db.delete(databaseView).where(inArray(databaseView.id, madeViews));
    if (madeProperties.length) await db.delete(databaseProperty).where(inArray(databaseProperty.id, madeProperties));
    if (sprintsId) await discard(tasks.workspaceId, [{ id: sprintsId }]);
    notifySchema(tasks.id);
    throw error;
  }
  notifySchema(tasks.id);
  notifySchema(sprintsId);
  await recordAudit({
    workspaceId: tasks.workspaceId,
    actorId: userId,
    action: "page.created",
    target: { type: "page", id: sprintsId, label: names.database },
    details: { kind: "database" },
  });
}

export type SprintCompletionResult = {
  completed: { id: string; title: string };
  current: { id: string; title: string; created: boolean };
  next: { id: string; title: string; created: boolean };
  /** Unfinished tasks of the completed sprint carried over to the new current one. */
  moved: number;
  /** Unfinished tasks left where they were: the person may not change them. */
  skipped: number;
};

/**
 * Completes the current sprint of a task database or of its sprints database (see
 * lib/sprints planSprintCompletion): the sprint is completed, the next one becomes current, a
 * new next one is planned when none waits, and the tasks of the completed sprint that aren't done
 * move to the new current one. Needs edit access to both databases and to the sprints it changes;
 * tasks the person may not change stay and are counted as skipped. One transaction, the sprints
 * locked while it runs, so two people completing at once complete one sprint. `dryRun` says what
 * it would do without doing it.
 */
export async function completeSprint(userId: string, databaseId: string, { dryRun = false }: { dryRun?: boolean } = {}): Promise<SprintCompletionResult> {
  await requireDatabase(userId, databaseId, "view");
  const setup = await sprintSetup(databaseId);
  if (!setup) throw refuse("Sprints are off for this database", "sprintsOff");
  const { config, tasksDatabaseId, sprintsDatabaseId, tasksPropertyId } = setup;
  const sprintPropertyId = setup.property.id;
  const [, sprintsDatabase] = await Promise.all([
    requireDatabase(userId, tasksDatabaseId, "edit"),
    requireDatabase(userId, sprintsDatabaseId, "edit"),
  ]);
  if (sprintsDatabase.archivedAt) throw refuse("The sprints database is in the trash", "invalidSprints");
  const [taskProperties, sprintProperties, taskAccess, sprintAccess, names] = await Promise.all([
    getProperties(tasksDatabaseId),
    getProperties(sprintsDatabaseId),
    propertyAccessFor(userId, tasksDatabaseId),
    propertyAccessFor(userId, sprintsDatabaseId),
    sprintNames(userId),
  ]);
  if (!fits(config, sprintProperties)) throw refuse("The sprints database no longer has its dates and states", "invalidSprints");
  const status = await taskStatus(tasksDatabaseId, config, taskProperties);
  const sprintKeys = [config.statePropertyId, config.datesPropertyId, ...(tasksPropertyId ? [tasksPropertyId] : [])];

  type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };
  const result = await db.transaction(async (tx) => {
    const sprints = await tx
      .select({ id: page.id, title: page.title, properties: page.properties, position: page.position, createdBy: page.createdBy, level: accessRank(userId, sql`${page.id}`) })
      .from(page)
      .where(and(eq(page.parentId, sprintsDatabaseId), eq(page.isTemplate, false), isNull(page.archivedAt)))
      .for("update");
    const plan = planSprintCompletion(sprints, config, {
      today: today(),
      newId: () => crypto.randomUUID(),
      title: (n) => names.sprintTitle.replace("{number}", String(n)),
    });
    if (!plan) throw refuse("No sprint is current", "noCurrentSprint");
    const existing = [plan.completed, ..."row" in plan.current ? [plan.current.row] : [], ..."row" in plan.next ? [plan.next.row] : []];
    for (const row of existing) {
      if (!hasLevel(levelFromRank(row.level), "content")) throw new AccessError();
      sprintAccess.requireValues(row, sprintKeys);
    }
    const currentId = "row" in plan.current ? plan.current.row.id : plan.current.create.id;
    const nextId = "row" in plan.next ? plan.next.row.id : plan.next.create.id;
    const summary = {
      completed: { id: plan.completed.id, title: plan.completed.title },
      current: "row" in plan.current ? { id: currentId, title: plan.current.row.title, created: false } : { id: currentId, title: plan.current.create.title, created: true },
      next: "row" in plan.next ? { id: nextId, title: plan.next.row.title, created: false } : { id: nextId, title: plan.next.create.title, created: true },
    };

    const linked = await tx
      .select({ id: page.id, properties: page.properties, createdBy: page.createdBy, level: accessRank(userId, sql`${page.id}`) })
      .from(page)
      .where(
        and(
          eq(page.parentId, tasksDatabaseId),
          eq(page.isTemplate, false),
          isNull(page.archivedAt),
          sql`${page.properties} -> ${sprintPropertyId} ? ${plan.completed.id}`,
        ),
      )
      .for("update");
    const moves = tasksToMove(linked, sprintPropertyId, plan.completed.id, currentId, (task) => !!status && isDoneStatus(status, task.properties[status.id]));
    const allowed = moves.filter(({ task }) => {
      if (!hasLevel(levelFromRank(task.level), "content")) return false;
      try {
        taskAccess.requireValues(task, [sprintPropertyId]);
        return true;
      } catch {
        return false;
      }
    });
    const counts = { moved: allowed.length, skipped: moves.length - allowed.length };
    if (dryRun) return { ...summary, ...counts, changes: null };

    const movedIds = allowed.map(({ task }) => task.id);
    const tasksOf = (row: SprintRow) => {
      const value = tasksPropertyId ? row.properties[tasksPropertyId] : undefined;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    };
    const sprintChanges: Change[] = [];
    const update = async (row: SprintRow, state: SprintState, tasks?: string[]) => {
      const set: Record<string, unknown> = { [config.statePropertyId]: config.states[state] };
      const cleared: string[] = [];
      if (tasksPropertyId && tasks) {
        if (tasks.length) set[tasksPropertyId] = tasks;
        else cleared.push(tasksPropertyId);
      }
      await tx.update(page).set({ properties: mergedProperties(set, cleared), updatedBy: userId }).where(eq(page.id, row.id));
      const after: Record<string, unknown> = { ...row.properties, ...set };
      for (const key of cleared) delete after[key];
      sprintChanges.push({ rowId: row.id, before: row.properties, after });
    };
    await update(plan.completed, "completed", tasksOf(plan.completed).filter((id) => !movedIds.includes(id)));
    if ("row" in plan.current) await update(plan.current.row, "current", [...new Set([...tasksOf(plan.current.row), ...movedIds])]);
    if ("row" in plan.next) await update(plan.next.row, "next");

    const created: Change[] = [];
    const fresh = [
      ...("create" in plan.current ? [{ sprint: plan.current.create, state: "current" as const, tasks: movedIds }] : []),
      ...("create" in plan.next ? [{ sprint: plan.next.create, state: "next" as const, tasks: [] }] : []),
    ];
    if (fresh.length) {
      await assertNestable(sprintsDatabaseId);
      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${page.position})` })
        .from(page)
        .where(eq(page.parentId, sprintsDatabaseId));
      const values = fresh.map(({ sprint, state, tasks }, i) => {
        const properties: Record<string, unknown> = { [config.statePropertyId]: config.states[state], [config.datesPropertyId]: sprint.dates };
        if (tasksPropertyId && tasks.length) properties[tasksPropertyId] = tasks;
        created.push({ rowId: sprint.id, before: {}, after: properties });
        return {
          id: sprint.id,
          workspaceId: sprintsDatabase.workspaceId,
          parentId: sprintsDatabaseId,
          kind: "page" as const,
          title: sprint.title,
          properties,
          position: (Number(max) || 0) + 1 + i,
          createdBy: userId,
          updatedBy: userId,
        };
      });
      await tx.insert(page).values(values);
    }

    const taskChanges: Change[] = [];
    for (const { task, sprints: value } of allowed) {
      await tx
        .update(page)
        .set({ properties: mergedProperties({ [sprintPropertyId]: value }, []), updatedBy: userId })
        .where(eq(page.id, task.id));
      taskChanges.push({ rowId: task.id, before: task.properties, after: { ...task.properties, [sprintPropertyId]: value } });
    }
    return { ...summary, ...counts, changes: { sprints: sprintChanges, created, tasks: taskChanges } };
  });

  const { changes, ...out } = result;
  if (!changes) return out;
  // What every row write sets off (activity, automations, followers), as each database's rows.
  await afterRowWrites(userId, sprintsDatabaseId, changes.sprints);
  if (changes.created.length) await afterRowWrites(userId, sprintsDatabaseId, changes.created, { created: true });
  if (changes.tasks.length) await afterRowWrites(userId, tasksDatabaseId, changes.tasks);
  notifyRows(sprintsDatabaseId);
  // Tasks show their sprint's state, which changed even for tasks that didn't move.
  notifyRows(tasksDatabaseId);
  if (changes.created.length) notifyTree(sprintsDatabase.workspaceId);
  for (const change of [...changes.sprints, ...changes.created]) rowChanged({ rowId: change.rowId, databaseId: sprintsDatabaseId, userId });
  for (const change of changes.tasks) rowChanged({ rowId: change.rowId, databaseId: tasksDatabaseId, userId });
  return out;
}

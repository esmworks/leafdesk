/**
 * End-to-end check of database view filters against the database: "and" / "or" at the top level
 * and in groups, person "me" inside groups, relative date ranges, stored configs from before
 * groups existed, rejected malformed configs, and the places that walk filter trees (deleting a
 * property, people a guest may see, duplicating a database).
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/filters-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { isDeepStrictEqual } = await import("node:util");
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
type ViewConfig = import("@/db/schema").ViewConfig;
const { registerCollab } = await import("@/server/collab/bridge");
const { setAssignmentMailer } = await import("@/server/assignments");
const { addProperty, addView, deleteProperty, getDatabase, getPeople, listRows, purgeProperty, updateView } = await import(
  "@/server/databases"
);
const { duplicatePage } = await import("@/server/duplicate");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { PropertyValueError } = await import("@/lib/properties");
const { dayString, filterRules } = await import("@/lib/filters");

const RUN = `filters-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
// Duplicating also titles the copy through it; the copy's page row carries the title anyway.
registerCollab({ broadcast() {}, async setTitle() {}, async disconnectLostAccess() {} } as unknown as Parameters<typeof registerCollab>[0]);
// Rows are created with people assigned; their emails are dropped instead of sent.
setAssignmentMailer(async () => {});

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

async function rejectsFilter(write: Promise<unknown>) {
  return write.then(
    () => false,
    (error: unknown) => error instanceof PropertyValueError && error.code === "invalidFilter",
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** A local calendar day `offset` days from today, as date properties store it. */
const day = (offset: number) => {
  const now = new Date();
  return dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
};

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["Todo", "Doing", "Done"] });
  const tags = await addProperty(ids.owner, tasks.id, { name: "Tags", type: "multi_select", options: ["bug", "ui"] });
  const assignee = await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const [todo, doing, done] = stage.options.options!;
  const [bug, ui] = tags.options.options!;

  const rows: Record<string, string> = {};
  const add = async (title: string, properties: Record<string, unknown>) => {
    rows[title] = (await createPage(actor, { workspaceId, parentId: tasks.id, title, properties })).id;
  };
  await add("today", { [stage.id]: todo.id, [tags.id]: [bug.id], [assignee.id]: [ids.owner], [due.id]: day(0) });
  await add("soon", { [stage.id]: doing.id, [tags.id]: [ui.id], [assignee.id]: [ids.member], [due.id]: day(3) });
  await add("recent", { [stage.id]: done.id, [tags.id]: [bug.id, ui.id], [due.id]: day(-3) });
  await add("far past", { [stage.id]: done.id, [due.id]: day(-40) });
  await add("far ahead", { [stage.id]: todo.id, [assignee.id]: [ids.member], [due.id]: day(40) });
  await add("undated", {});

  const titles = async (config: ViewConfig, viewer = ids.owner) =>
    (await listRows(viewer, tasks.id, config)).map((r) => r.title).sort().join(",");

  // A stored config from before groups: a plain list, and-combined
  const view = await addView(ids.owner, tasks.id, { name: "Filtered", type: "table" });
  const legacy: ViewConfig = {
    filters: [
      { propertyId: stage.id, op: "equals", value: done.id },
      { propertyId: tags.id, op: "contains", value: bug.id },
    ],
  };
  await updateView(ids.owner, view.id, { config: legacy });
  const [stored] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  check((await titles(stored.config)) === "recent", "a plain rule list still filters with and", await titles(stored.config));

  // Top-level "or"
  check(
    (await titles({ ...legacy, filterCombinator: "or" })) === "far past,recent,today",
    "the same rules combined with or match either",
    await titles({ ...legacy, filterCombinator: "or" }),
  );

  // Groups, and "me" inside a group
  const mineOrDone: ViewConfig = {
    filters: [
      { propertyId: tags.id, op: "is_not_empty" },
      {
        type: "group",
        combinator: "or",
        rules: [
          { propertyId: assignee.id, op: "contains", value: "me" },
          { propertyId: stage.id, op: "equals", value: done.id },
        ],
      },
    ],
  };
  check((await titles(mineOrDone, ids.owner)) === "recent,today", "tagged and (mine or done), seen by the owner", await titles(mineOrDone));
  check(
    (await titles(mineOrDone, ids.member)) === "recent,soon",
    "…and the same view shows the member their own rows",
    await titles(mineOrDone, ids.member),
  );
  const nested: ViewConfig = {
    filterCombinator: "or",
    filters: [
      { propertyId: stage.id, op: "equals", value: doing.id },
      {
        type: "group",
        combinator: "and",
        rules: [
          { propertyId: stage.id, op: "equals", value: todo.id },
          {
            type: "group",
            combinator: "or",
            rules: [
              { propertyId: assignee.id, op: "contains", value: ids.member },
              { propertyId: tags.id, op: "contains", value: bug.id },
            ],
          },
        ],
      },
    ],
  };
  check((await titles(nested)) === "far ahead,soon,today", "groups nested two levels deep", await titles(nested));

  // Incomplete rules and empty groups filter nothing, also inside an "or"
  const incomplete: ViewConfig = {
    filterCombinator: "or",
    filters: [
      { propertyId: stage.id, op: "equals", value: doing.id },
      { propertyId: stage.id, op: "equals" },
      { type: "group", combinator: "and", rules: [] },
    ],
  };
  check((await titles(incomplete)) === "soon", "incomplete rules and empty groups don't widen an or", await titles(incomplete));

  // Relative dates, counted from today
  const within = (value: string, days?: number): ViewConfig => ({
    filters: [{ propertyId: due.id, op: "is_within", value, ...(days ? { days } : {}) }],
  });
  check((await titles(within("today"))) === "today", "due today", await titles(within("today")));
  check((await titles(within("past_n_days", 3))) === "recent,today", "due in the past 3 days", await titles(within("past_n_days", 3)));
  check((await titles(within("next_n_days", 3))) === "soon,today", "due in the next 3 days", await titles(within("next_n_days", 3)));
  const thisWeek = await titles(within("this_week"));
  check(thisWeek.split(",").includes("today") && !/far|undated/.test(thisWeek), "due this week", thisWeek);
  const thisMonth = await titles(within("this_month"));
  check(thisMonth.split(",").includes("today") && !/far|undated/.test(thisMonth), "due this month", thisMonth);
  check((await titles(within("past_n_days"))) === (await titles({})), "past N days without N filters nothing yet");
  const created = await titles({ filters: [{ propertyId: "created_at", op: "is_within", value: "today" }] });
  check(created === (await titles({})), "rows created today match created time is today", created);

  // Malformed configs are rejected and leave the stored one alone
  const bad: [string, ViewConfig][] = [
    ["an unknown op", { filters: [{ propertyId: stage.id, op: "matches" as never, value: "x" }] }],
    ["an unknown combinator", { filters: [], filterCombinator: "xor" as never }],
    [
      "groups nested three levels deep",
      {
        filters: [
          { type: "group", combinator: "or", rules: [{ type: "group", combinator: "or", rules: [{ type: "group", combinator: "or", rules: [] }] }] },
        ],
      },
    ],
    ["an unknown relative range", { filters: [{ propertyId: due.id, op: "is_within", value: "someday" }] }],
    ["a day count of zero", { filters: [{ propertyId: due.id, op: "is_within", value: "past_n_days", days: 0 }] }],
  ];
  for (const [what, config] of bad) {
    check(await rejectsFilter(updateView(ids.owner, view.id, { config })), `a view config with ${what} is rejected`);
  }
  const [unchanged] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  check(JSON.stringify(unchanged.config) === JSON.stringify(stored.config), "…and the stored config stays as it was", unchanged.config);

  // A guest sees the people filters point at, also inside groups
  await setPagePermission(ids.owner, tasks.id, ids.guest, "view");
  await updateView(ids.owner, view.id, {
    config: {
      filters: [
        {
          type: "group",
          combinator: "or",
          rules: [{ type: "group", combinator: "and", rules: [{ propertyId: assignee.id, op: "contains", value: ids.owner }] }],
        },
      ],
    },
  });
  const { properties } = await getDatabase(ids.owner, tasks.id);
  const [todayRow] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rows.today));
  check(todayRow.properties[assignee.id], "the owner is assigned in a row");
  await db.update(page).set({ properties: {} }).where(eq(page.id, rows.today));
  const seen = (await getPeople(ids.guest, properties)).map((p) => p.id);
  check(seen.includes(ids.owner), "a guest sees a person named only by a nested filter", seen);

  // Duplicating the database carries groups over with the copy's property ids
  await updateView(ids.owner, view.id, { config: { ...mineOrDone, filterCombinator: "or" } });
  const copy = await duplicatePage(actor, tasks.id, " (copy)");
  const copyViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, copy.id));
  const copied = copyViews.find((v) => v.name === "Filtered");
  const copyProps = (await getDatabase(ids.owner, copy.id)).properties;
  const copiedRules = filterRules(copied?.config.filters);
  check(
    copied?.config.filterCombinator === "or" &&
      copied.config.filters?.[1] &&
      "type" in copied.config.filters[1] &&
      copiedRules.length === 3 &&
      copiedRules.every((r) => copyProps.some((p) => p.id === r.propertyId)),
    "a duplicated view keeps its groups, pointing at the copy's properties",
    copied?.config,
  );

  // Deleting a property removes its rules from groups and drops groups left empty
  await updateView(ids.owner, view.id, {
    config: {
      filters: [
        { propertyId: tags.id, op: "is_not_empty" },
        { type: "group", combinator: "or", rules: [{ propertyId: assignee.id, op: "contains", value: "me" }] },
        {
          type: "group",
          combinator: "or",
          rules: [
            { propertyId: assignee.id, op: "is_empty" },
            { type: "group", combinator: "and", rules: [{ propertyId: stage.id, op: "equals", value: done.id }] },
          ],
        },
      ],
    },
  });
  await deleteProperty(ids.owner, assignee.id);
  const [heldRules] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  check(JSON.stringify(heldRules.config.filters).includes(assignee.id), "a deleted property's rules stay stored, for a restore");
  const afterDelete = (await getDatabase(ids.owner, tasks.id)).views.find((v) => v.id === view.id)!;
  const expected = [
    { propertyId: tags.id, op: "is_not_empty" },
    {
      type: "group",
      combinator: "or",
      rules: [{ type: "group", combinator: "and", rules: [{ propertyId: stage.id, op: "equals", value: done.id }] }],
    },
  ];
  check(
    // jsonb reorders keys, so compare structurally.
    isDeepStrictEqual(afterDelete.config.filters, expected),
    "a deleted property's rules are ignored at every depth, dropping emptied groups",
    afterDelete.config.filters,
  );
  await purgeProperty(ids.owner, assignee.id);
  const [purged] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  check(isDeepStrictEqual(purged.config.filters, expected), "deleting it for good removes them from the stored view", purged.config.filters);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

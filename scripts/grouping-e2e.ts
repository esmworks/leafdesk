/**
 * End-to-end check of grouping against the database: dragging a row to another group (moveRow)
 * sets a sensible value for every groupable type and is validated like any edit, two-way
 * relations follow a move, who created a row and when never change, and grouped views keep their
 * settings. Groups are then built from the stored rows with the same module the UI uses.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/grouping-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, addView, deleteProperty, getDatabaseSnapshot, getProperties, moveRow, updateView } = await import(
  "@/server/databases"
);
const { createPage } = await import("@/server/pages");
const { PropertyValueError } = await import("@/lib/properties");
const { arrangeGroups, groupDefaults, groupRowsBy, groupTarget } = await import("@/lib/grouping");

const RUN = `grouping-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({ async pagesTrashed() {}, broadcast: () => {} } as unknown as Parameters<typeof registerCollab>[0]);

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

async function rejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof PropertyValueError && error.code === code;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

async function values(rowId: string) {
  const [row] = await db.select({ properties: page.properties, position: page.position }).from(page).where(eq(page.id, rowId));
  return row.properties;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const projects = await createPage(actor, { workspaceId, kind: "database", title: "Projects" });
  for (const prop of await getProperties(tasks.id)) await deleteProperty(ids.owner, prop.id);

  const priority = await addProperty(ids.owner, tasks.id, { name: "Priority", type: "select", options: ["Low", "High"] });
  const tags = await addProperty(ids.owner, tasks.id, { name: "Tags", type: "multi_select", options: ["Bug", "UI", "Docs"] });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "status" });
  const doneBox = await addProperty(ids.owner, tasks.id, { name: "Done", type: "checkbox" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const notes = await addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const created = await addProperty(ids.owner, tasks.id, { name: "Created", type: "created_time" });
  const project = await addProperty(ids.owner, tasks.id, {
    name: "Project",
    type: "relation",
    relation: { databaseId: projects.id, twoWay: true, pairedName: "Tasks" },
  });
  const pairedId = project.options.relation!.pairedPropertyId!;
  const [, high] = priority.options.options!;
  const [bug, ui, docs] = tags.options.options!;
  const [, inProgress] = stage.options.options!;
  const p1 = await createPage(actor, { workspaceId, parentId: projects.id, title: "Apollo" });
  const p2 = await createPage(actor, { workspaceId, parentId: projects.id, title: "Gemini" });
  const r1 = await createPage(actor, {
    workspaceId,
    parentId: tasks.id,
    title: "r1",
    properties: { Tags: ["Bug", "UI"], Project: [p1.id], Priority: "Low", Due: "2026-09-24" },
  });
  const r2 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r2", properties: { Tags: ["Bug"] } });

  // Multi-select: the dragged-from option is swapped for the target, the rest stays
  await moveRow(ids.member, r1.id, { groupBy: tags.id, groupFrom: bug.id, groupValue: docs.id });
  check(same((await values(r1.id))[tags.id], [docs.id, ui.id]), "a multi-select move swaps the source option for the target", await values(r1.id));
  await moveRow(ids.member, r1.id, { groupBy: tags.id, groupFrom: docs.id, groupValue: ui.id });
  check(same((await values(r1.id))[tags.id], [ui.id]), "…and merges when the row already has the target", await values(r1.id));
  await moveRow(ids.member, r2.id, { groupBy: tags.id, groupFrom: bug.id, groupValue: null });
  check(!(tags.id in (await values(r2.id))), "moving to no value clears a multi-select", await values(r2.id));
  await moveRow(ids.member, r2.id, { groupBy: tags.id, groupFrom: null, groupValue: bug.id });
  check(same((await values(r2.id))[tags.id], [bug.id]), "moving out of no value adds the option", await values(r2.id));
  check(
    await rejects(() => moveRow(ids.member, r2.id, { groupBy: tags.id, groupFrom: bug.id, groupValue: "no-such-option" }), "unknownOption"),
    "an unknown multi-select option is refused",
  );

  // Select and status: the target option, validated
  await moveRow(ids.member, r1.id, { groupBy: priority.id, groupValue: high.id });
  check((await values(r1.id))[priority.id] === high.id, "a select move sets the target option");
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: priority.id, groupValue: "no-such-option" }), "unknownOption"),
    "a select move to an unknown option is refused",
  );
  check((await values(r1.id))[priority.id] === high.id, "…and leaves the value alone", await values(r1.id));
  await moveRow(ids.member, r1.id, { groupBy: priority.id, groupValue: null });
  check(!(priority.id in (await values(r1.id))), "a select move to no value clears it");
  const snapshot = await getDatabaseSnapshot(ids.owner, tasks.id);
  const stageProp = snapshot.properties.find((p) => p.id === stage.id)!;
  const stages = groupRowsBy(snapshot.rows, stageProp, { groupStatusBy: "group" });
  const target = groupTarget(stageProp, stages.find((g) => g.key === "in_progress")!);
  check(target === inProgress.id, "a status stage targets its first option", target);
  await moveRow(ids.member, r2.id, { groupBy: stage.id, groupValue: target });
  check((await values(r2.id))[stage.id] === inProgress.id, "a status stage move sets that option");

  // Checkbox: checked or unchecked
  await moveRow(ids.member, r1.id, { groupBy: doneBox.id, groupValue: "true" });
  check((await values(r1.id))[doneBox.id] === true, "a checkbox move to checked ticks the box");
  await moveRow(ids.member, r1.id, { groupBy: doneBox.id, groupFrom: "true", groupValue: "false" });
  check((await values(r1.id))[doneBox.id] === false, "…and to unchecked clears it");

  // Date: the bucket's first day
  await moveRow(ids.member, r1.id, { groupBy: due.id, groupValue: "2026-09-28" });
  check((await values(r1.id))[due.id] === "2026-09-28", "a date move sets the group's first day");
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: due.id, groupValue: "next week" }), "invalidDate"),
    "a date move to something that isn't a day is refused",
  );
  await moveRow(ids.member, r1.id, { groupBy: due.id, groupValue: null });
  check(!(due.id in (await values(r1.id))), "a date move to no value clears it");

  // Relation: the linked row is swapped, and the two-way side follows
  await moveRow(ids.member, r1.id, { groupBy: project.id, groupFrom: p1.id, groupValue: p2.id });
  check(same((await values(r1.id))[project.id], [p2.id]), "a relation move swaps the linked row", await values(r1.id));
  const [back1, back2] = [(await values(p1.id))[pairedId], (await values(p2.id))[pairedId]];
  check(!(Array.isArray(back1) && back1.includes(r1.id)) && same(back2, [r1.id]), "…and the related rows' links back follow", [back1, back2]);
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: project.id, groupFrom: p2.id, groupValue: tasks.id }), "invalidRelation"),
    "a relation move to a row outside the related database is refused",
  );

  // What can't be grouped by, or moved in, is refused
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: created.id, groupValue: "2026-01-01" }), "readOnlyProperty"),
    "rows can't be moved between created time groups",
  );
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: notes.id, groupValue: "hello" }), "unsupportedType"),
    "rows can't be moved by a property views don't group by",
  );
  check(
    await rejects(() => moveRow(ids.member, r1.id, { groupBy: "no-such-property", groupValue: "x" }), "unknownProperty"),
    "an unknown grouping property is refused",
  );
  await moveRow(ids.member, r2.id, { position: -5 });
  const [{ position }] = await db.select({ position: page.position }).from(page).where(eq(page.id, r2.id));
  check(position === -5, "moves without a group only reorder", position);

  // Groups built from the stored rows, as the UI builds them
  const fresh = await getDatabaseSnapshot(ids.owner, tasks.id);
  const projectProp = fresh.properties.find((p) => p.id === project.id)!;
  const byProject = groupRowsBy(fresh.rows, projectProp, {}, { relationRows: fresh.relations[project.id].rows });
  check(
    same(byProject.map((g) => [g.key, g.rows.map((r) => r.title)]), [["", ["r2"]], [p2.id, ["r1"]]]),
    "relation groups hold the rows linked to each related row",
    byProject.map((g) => [g.key, g.rows.map((r) => r.title)]),
  );
  const tagsProp = fresh.properties.find((p) => p.id === tags.id)!;
  const byTag = arrangeGroups(groupRowsBy(fresh.rows, tagsProp), { hideEmptyGroups: true });
  check(same(byTag.shown.map((g) => g.key), [bug.id, ui.id]), "empty tag groups can be left out", byTag.shown.map((g) => g.key));
  const defaults = groupDefaults(tagsProp, byTag.shown[0]);
  const r3 = await createPage(actor, { workspaceId, parentId: tasks.id, title: "r3", properties: defaults });
  check(same((await values(r3.id))[tags.id], [bug.id]), "a row added in a group gets the group's value", await values(r3.id));

  // Grouped table views keep their settings; deleting the property ungroups them
  const table = await addView(ids.owner, tasks.id, { name: "By week", type: "table" });
  check(table.config.groupBy === undefined, "a new table is not grouped", table.config);
  const config = {
    groupBy: due.id,
    groupDateBy: "week" as const,
    hideEmptyGroups: true,
    collapsedGroups: ["2026-09-21"],
    hiddenGroups: [""],
  };
  await updateView(ids.member, table.id, { config });
  const saved = (await getDatabaseSnapshot(ids.owner, tasks.id)).views.find((v) => v.id === table.id)!;
  const kept = Object.entries(config).every(([key, value]) => same(saved.config[key as keyof typeof config], value));
  check(kept, "a grouped table view keeps its group settings", saved.config);
  await deleteProperty(ids.owner, due.id);
  const ungrouped = (await getDatabaseSnapshot(ids.owner, tasks.id)).views.find((v) => v.id === table.id)!;
  check(ungrouped.config.groupBy === undefined, "deleting the grouping property ungroups the view", ungrouped.config);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

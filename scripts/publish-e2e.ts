/**
 * End-to-end check of publishing options: which views of a published database visitors can switch
 * between (and who may pick them), how each view is drawn (boards by published properties only,
 * grouped tables, lists, galleries), view ids from the URL that aren't on the web, and the "allow
 * search engines" setting of a publication.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/publish-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseProperty, user, workspace, workspaceMember } = await import("@/db/schema");
const { addProperty, addView, createRows, getDatabaseSnapshot, getProperties, updateView } = await import("@/server/databases");
const { getPublishedPage, getWebViews, listWorkspacePublications, publishPage, setPublicationIndexable, setWebViews, PublishError } =
  await import("@/server/publication");
const { duplicatePage } = await import("@/server/duplicate");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");

const RUN = `publish-e2e-${Date.now().toString(36)}`;

// The real collab service: new pages get their documents through it.
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

async function fails(fn: () => Promise<unknown>, kind: "access" | "publish") {
  try {
    await fn();
    return false;
  } catch (error) {
    return kind === "access" ? error instanceof AccessError : error instanceof PublishError;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, editor: `${RUN}-editor` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.editor, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  // Members get edit access; the owner and, later, one member get full access.
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "edit");
  const size = await addProperty(ids.owner, tasks.id, { name: "Size", type: "select", options: ["S", "L"] });
  const owner = await addProperty(ids.owner, tasks.id, { name: "Owner", type: "person" });
  const notes = await addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const props = await getProperties(tasks.id);
  const status = props.find((p) => p.type === "status")!;
  const [small, large] = props.find((p) => p.id === size.id)!.options.options!;
  const [todo] = status.options.options!;
  const rows = await createRows(ids.owner, tasks.id, [
    { title: "One", properties: { [size.id]: small.id, [status.id]: todo.id, [owner.id]: [ids.owner], [notes.id]: "n1" } },
    { title: "Two", properties: { [size.id]: large.id } },
    { title: "Three", properties: { [size.id]: small.id } },
  ]);
  const [table] = (await getDatabaseSnapshot(ids.owner, tasks.id)).views;
  const board = await addView(ids.owner, tasks.id, { name: "Board", type: "board" });
  const list = await addView(ids.owner, tasks.id, { name: "List", type: "list" });
  const gallery = await addView(ids.owner, tasks.id, { name: "Cards", type: "gallery" });
  const form = await addView(ids.owner, tasks.id, { name: "Ask", type: "form" });
  const { token } = await publishPage(ids.owner, tasks.id);

  // Before anyone picks views: the first view only
  const initial = await getWebViews(ids.owner, tasks.id);
  check(
    initial?.filter((v) => v.published).map((v) => v.id).join() === table.id && !initial.some((v) => v.id === form.id),
    "a database shows its first view on the web until views are picked; forms are never offered",
    initial,
  );
  let data = (await getPublishedPage(token))!.database!;
  check(data.view?.id === table.id && data.views.length === 1 && data.layout === "table", "the published page shows the first view as a table", data.view);
  check(data.rows.length === 3 && !data.properties.some((p) => p.id === owner.id), "people stay off the published table", data.properties.map((p) => p.name));
  check((await getWebViews(ids.owner, rows[0].id)) === null, "pages that aren't databases have no web views");

  // Who may pick views
  check(await fails(() => setWebViews(ids.editor, tasks.id, [board.id]), "access"), "editing the database isn't enough to pick web views");
  check(await fails(() => setWebViews(ids.owner, tasks.id, []), "publish"), "at least one view stays on the web");
  check(await fails(() => setWebViews(ids.owner, tasks.id, [form.id]), "publish"), "a form can't be a web view");
  const other = await createPage(actor, { workspaceId, kind: "database", title: "Other" });
  const [otherView] = (await getDatabaseSnapshot(ids.owner, other.id)).views;
  check(await fails(() => setWebViews(ids.owner, tasks.id, [otherView.id]), "publish"), "views of another database can't be picked");
  await updateWorkspaceSettings(ids.owner, workspaceId, { publishing: "owners" });
  await setPagePermission(ids.owner, tasks.id, ids.member, "full");
  check(await fails(() => setWebViews(ids.member, tasks.id, [board.id]), "publish"), "members can't pick web views where only owners publish");
  await updateWorkspaceSettings(ids.owner, workspaceId, { publishing: "members" });
  await setWebViews(ids.member, tasks.id, [list.id, board.id, gallery.id]);

  // Visitors switch between the picked views, in the database's order
  data = (await getPublishedPage(token))!.database!;
  check(data.views.map((v) => v.id).join() === [board.id, list.id, gallery.id].join(), "the picked views are offered in the database's order", data.views);
  check(data.view?.id === board.id && data.layout === "board", "the first picked view shows by default, as a board", data.view);
  check(
    data.groups?.property.id === status.id && data.groups.list.some((g) => g.rowIds.includes(rows[0].id)),
    "a board groups by its status property",
    data.groups,
  );
  check(!data.properties.some((p) => p.id === status.id), "cards don't repeat the column property");
  data = (await getPublishedPage(token, undefined, list.id))!.database!;
  check(data.view?.id === list.id && data.layout === "list", "?view= shows another picked view", data.view);
  await updateView(ids.owner, list.id, { config: { hidden: [notes.id] } });
  data = (await getPublishedPage(token, undefined, list.id))!.database!;
  check(!JSON.stringify(data).includes("n1"), "values of properties the view hides don't reach the page", data.rows);
  data = (await getPublishedPage(token, undefined, table.id))!.database!;
  check(data.view?.id === board.id, "a view that isn't on the web falls back to the default one", data.view);
  data = (await getPublishedPage(token, undefined, otherView.id))!.database!;
  check(data.view?.id === board.id, "another database's view falls back to the default one", data.view);
  data = (await getPublishedPage(token, undefined, gallery.id))!.database!;
  check(data.layout === "gallery" && data.rows.every((r) => r.cover === null) && data.cardSize === "medium", "a gallery shows cards, without covers when rows have no images", data.rows);

  // Boards whose columns would name people show as tables
  await updateView(ids.owner, board.id, { config: { groupBy: owner.id } });
  data = (await getPublishedPage(token))!.database!;
  check(data.layout === "table" && data.groups === null, "a board by person shows as an ungrouped table", data.layout);
  check(!JSON.stringify(data).includes(ids.owner), "no person's id reaches the published page");

  // Grouped tables show sections, without the groups the view hides
  await setWebViews(ids.owner, tasks.id, [table.id]);
  await updateView(ids.owner, table.id, { config: { groupBy: size.id, hiddenGroups: [large.id] } });
  data = (await getPublishedPage(token))!.database!;
  check(
    data.layout === "table" && data.groups?.list.map((g) => g.key).join() === small.id && data.groups.list[0].rowIds.length === 2,
    "a grouped table shows its sections, minus hidden groups",
    data.groups,
  );

  // Properties reach visitors with what drawing their values takes, not how they are set up
  const verdict = await addProperty(ids.owner, tasks.id, {
    name: "Verdict",
    type: "formula",
    formula: { expression: 'if(prop("Notes") == "never-shown-marker", "yes", "no")' },
  });
  const summary = await addProperty(ids.owner, tasks.id, { name: "Summary", type: "text" });
  const due = await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  await db
    .update(databaseProperty)
    .set({ options: sql`${databaseProperty.options} || ${JSON.stringify({ ai: { mode: "custom", prompt: "prompt-marker {Notes}" } })}::jsonb` })
    .where(eq(databaseProperty.id, summary.id));
  await db
    .update(databaseProperty)
    .set({
      options: sql`${databaseProperty.options} || ${JSON.stringify({ date: { display: "relative", reminder: { daysBefore: 2, timeZone: "Europe/Istanbul", since: new Date().toISOString() } } })}::jsonb`,
    })
    .where(eq(databaseProperty.id, due.id));
  await updateView(ids.owner, table.id, { config: { groupBy: size.id } });
  data = (await getPublishedPage(token))!.database!;
  const published = JSON.stringify(data);
  const shownVerdict = data.properties.find((p) => p.id === verdict.id);
  check(shownVerdict?.options.formula?.type === "text" && !("expression" in (shownVerdict.options.formula ?? {})), "a published formula keeps its result type, not its expression", shownVerdict);
  check(
    !published.includes("never-shown-marker") && !published.includes("prompt-marker") && !published.includes("reminder") && !published.includes("Europe/Istanbul"),
    "no formula expression, AI prompt or reminder reaches the published database",
  );
  check(data.properties.find((p) => p.id === due.id)?.options.date?.display === "relative", "…while a date still shows as relative");
  check(
    data.properties.every((p) => Object.keys(p).sort().join() === "id,name,options,type") &&
      Object.keys(data.groups!.property).sort().join() === "id,name,options,type",
    "published properties carry only their id, name, type and display options",
    data.properties,
  );
  const rowPage = JSON.stringify((await getPublishedPage(token, rows[0].id))!.row);
  check(!rowPage.includes("never-shown-marker") && !rowPage.includes("prompt-marker") && !rowPage.includes("reminder"), "…nor the published page of a row");

  // Copies aren't on the web with their original's picks
  await setWebViews(ids.owner, tasks.id, [list.id]);
  const copy = await duplicatePage(actor, tasks.id, " (copy)");
  const copied = await getWebViews(ids.owner, copy.id);
  check(copied?.filter((v) => v.published).length === 1 && copied[0].published, "a copied database starts with its first view on the web", copied);

  // Search engines
  check((await getPublishedPage(token))!.indexable === false, "published pages stay out of search engines by default");
  check(await fails(() => setPublicationIndexable(ids.editor, tasks.id, true), "access"), "only people with full access allow search engines");
  check(await fails(() => setPublicationIndexable(ids.owner, other.id, true), "publish"), "unpublished pages can't be opened to search engines");
  await setPublicationIndexable(ids.member, tasks.id, true);
  check((await getPublishedPage(token))!.indexable, "the publication allows search engines");
  check((await getPublishedPage(token, rows[0].id))!.indexable, "…and its subpages with it");
  const listed = (await listWorkspacePublications(ids.owner, workspaceId)).find((p) => p.pageId === tasks.id);
  check(listed?.indexable === true, "owners see which publications search engines may index", listed);
  await setPublicationIndexable(ids.owner, tasks.id, false);
  check(!(await getPublishedPage(token))!.indexable, "search engines can be turned off again");
  const again = await publishPage(ids.owner, tasks.id);
  check(again.token === token && again.indexable === false, "publishing again keeps the link and its setting");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

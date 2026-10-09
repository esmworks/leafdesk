/**
 * End-to-end check of the workspace graph against the database: the pages someone can open as
 * nodes (pages, databases, rows), links, relations (a two-way one counted once) and the page tree
 * as edges, nothing from the trash, templates or other workspaces, no edge to a page the reader
 * can't open, guests and outsiders, and the cap on pages. Creates its own users and workspaces and
 * deletes them afterwards.
 *
 *   pnpm tsx scripts/graph-e2e.ts
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
const { pairKey } = await import("@/lib/graph");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { workspaceGraph } = await import("@/server/graph");
const { AccessError } = await import("@/server/access");

const RUN = `graph-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-other`;
const owner = { userId: ids.owner };
const link = (pageId: string) => `[x](/w/${workspaceId}/p/${pageId})`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  const home = await createPage(owner, { workspaceId, title: "Home" });
  const notes = await createPage(owner, { workspaceId, parentId: home.id, title: "Notes" });
  const people = await createPage(owner, { workspaceId, kind: "database", title: "People" });
  const projects = await createPage(owner, { workspaceId, kind: "database", title: "Projects" });
  await databases.addProperty(ids.owner, projects.id, { name: "Team", type: "relation", relation: { databaseId: people.id, twoWay: true } });
  const ada = await createPage(owner, { workspaceId, parentId: people.id, title: "Ada" });
  const hiddenRow = await createPage(owner, { workspaceId, parentId: people.id, title: "Hidden row" });
  await setPagePermission(ids.owner, hiddenRow.id, ids.owner, "full");
  await setPagePermission(ids.owner, hiddenRow.id, null, "none");
  const launch = await createPage(owner, { workspaceId, parentId: projects.id, title: "Launch", properties: { Team: [ada.id, hiddenRow.id] } });
  const secret = await createPage(owner, { workspaceId, title: "Secret" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  await getCollab().replaceContent(notes.id, `See ${link(launch.id)} and ${link(secret.id)}.`, owner);
  const trashed = await createPage(owner, { workspaceId, title: "Trashed" });
  await getCollab().replaceContent(trashed.id, `About ${link(home.id)}`, owner);
  await archivePage(ids.owner, trashed.id);
  const template = await createPage(owner, { workspaceId, title: "Template" });
  await db.update(page).set({ inTemplate: true }).where(eq(page.id, template.id));
  const foreign = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Elsewhere" });

  const graph = await workspaceGraph(ids.owner, workspaceId);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edge = (a: string, b: string) => graph.edges.find((e) => pairKey(e.source, e.target) === pairKey(a, b));
  check(
    [home, notes, people, projects, ada, launch, secret, hiddenRow].every((p) => byId.has(p.id)) &&
      ![trashed, template, foreign].some((p) => byId.has(p.id)),
    "the owner's graph has the workspace's pages, not the trash, templates or other workspaces",
    graph.nodes,
  );
  check(
    byId.get(people.id)?.kind === "database" && byId.get(ada.id)?.kind === "row" && byId.get(notes.id)?.kind === "page",
    "nodes are pages, databases and rows",
  );
  check(
    byId.get(ada.id)?.parent === people.id && byId.get(notes.id)?.parent === home.id && byId.get(home.id)?.parent === undefined,
    "a page knows the page it is inside, a row its database",
  );
  check(edge(home.id, notes.id)?.kind === "child" && edge(people.id, ada.id)?.kind === "child", "the page tree is an edge, rows inside their database");
  check(edge(notes.id, launch.id)?.kind === "link" && edge(notes.id, secret.id)?.kind === "link", "a link in a body is an edge");
  check(edge(launch.id, ada.id)?.kind === "relation" && edge(launch.id, hiddenRow.id)?.kind === "relation", "a relation is an edge", graph.edges);
  check(
    graph.edges.filter((e) => pairKey(e.source, e.target) === pairKey(launch.id, ada.id)).length === 1,
    "…once, though the two-way relation holds it on both rows",
  );
  check(!graph.edges.some((e) => e.source === trashed.id || e.target === trashed.id), "nothing leads to the trash");
  check(!graph.truncated, "a small workspace isn't cut");

  const asMember = await workspaceGraph(ids.member, workspaceId);
  const memberIds = new Set(asMember.nodes.map((n) => n.id));
  check(!memberIds.has(secret.id) && !memberIds.has(hiddenRow.id) && memberIds.has(notes.id), "a member doesn't get the pages they can't open");
  check(
    !asMember.edges.some((e) => [secret.id, hiddenRow.id].includes(e.source) || [secret.id, hiddenRow.id].includes(e.target)),
    "…nor any edge to them, from a link or a relation",
    asMember.edges,
  );

  await setPagePermission(ids.owner, notes.id, ids.guest, "view");
  const asGuest = await workspaceGraph(ids.guest, workspaceId);
  check(asGuest.nodes.map((n) => n.id).join() === notes.id && asGuest.edges.length === 0, "a guest gets only what is shared with them", asGuest);
  check(asGuest.nodes[0]?.parent === undefined, "…not even the id of the page it is inside", asGuest);

  let refused = false;
  try {
    await workspaceGraph(ids.outsider, workspaceId);
  } catch (error) {
    refused = error instanceof AccessError;
  }
  check(refused, "someone outside the workspace gets nothing");

  const capped = await workspaceGraph(ids.owner, workspaceId, { maxNodes: 3 });
  check(
    capped.truncated && capped.nodes.length === 3 && capped.edges.every((e) => capped.nodes.some((n) => n.id === e.source) && capped.nodes.some((n) => n.id === e.target)),
    "past the cap the graph is cut, with edges only between the pages it keeps",
    capped,
  );
  check(
    capped.nodes.every((n) => !n.parent || capped.nodes.some((m) => m.id === n.parent)),
    "…and parents only among them",
    capped,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

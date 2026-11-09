/**
 * End-to-end check of writes made at the same moment against the database and the real collab
 * service: server writes of a page's body without an expected version, made together, all land
 * (each is made again on the body the others left); two people setting the same row's two-way
 * relation at once leave the linked rows' back-links as the row ends up; two people adding a tag
 * to the same row at once, each from the list they saw, both keep theirs, and a removal takes away
 * only what it removed.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/concurrent-writes-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
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
const { createCollab } = await import("@/server/collab/service");
const { addProperty, updateProperty, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");

const RUN = `concurrent-writes-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const sorted = (v: unknown) => (Array.isArray(v) ? [...v].sort() : []);
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const valuesOf = async (rowId: string) => (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };

  // ── Body writes made together ─────────────────────────────────────────────────────────────
  const notes = await createPage(owner, { workspaceId, title: "Notes", markdown: "Start" });
  const words = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  await Promise.all(words.map((word) => service.appendContent(notes.id, word, owner)));
  const body = JSON.stringify((await service.readBlocks(notes.id)).blocks);
  const missing = ["Start", ...words].filter((word) => !body.includes(word));
  check(!missing.length, "five appends to one page at once all land, none written over by another", { body, missing });

  const blocks = (await service.readBlocks(notes.id)).blocks as { id: string }[];
  const first = blocks[0].id;
  await Promise.all([
    service.updateBlockProps(notes.id, first, () => ({ textColor: "red" }), owner),
    service.appendContent(notes.id, "Foxtrot", owner),
  ]);
  const after = (await service.readBlocks(notes.id)).blocks as { id: string; props?: { textColor?: string } }[];
  const afterText = JSON.stringify((await service.readBlocks(notes.id)).blocks);
  check(after.find((b) => b.id === first)?.props?.textColor === "red" && afterText.includes("Foxtrot"), "a block's props changed while another write appends: both stay", { afterText });

  // ── Two-way relations set at once ─────────────────────────────────────────────────────────
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  const clients = await createPage(owner, { workspaceId, kind: "database", title: "Clients" });
  const client = await addProperty(ids.owner, tasks.id, {
    name: "Clients",
    type: "relation",
    relation: { databaseId: clients.id, twoWay: true, pairedName: "Tasks" },
  });
  const pairedId = client.options.relation!.pairedPropertyId!;
  const [x, y, z] = await Promise.all(["X", "Y", "Z"].map((title) => createPage(owner, { workspaceId, parentId: clients.id, title })));

  for (let round = 0; round < 5; round++) {
    const task = await createPage(owner, { workspaceId, parentId: tasks.id, title: `Task ${round}`, properties: { [client.id]: [x.id] } });
    // Both read [x]; one sets [x, y], the other [x, z], written as given (no base).
    await Promise.all([
      updateRowProperties(ids.owner, task.id, { [client.id]: [x.id, y.id] }),
      updateRowProperties(ids.member, task.id, { [client.id]: [x.id, z.id] }),
    ]);
    const linked = sorted((await valuesOf(task.id))[client.id]);
    const backs = await Promise.all([x, y, z].map(async (c) => ({ id: c.id, links: sorted((await valuesOf(c.id))[pairedId]).includes(task.id) })));
    const stray = backs.filter((b) => b.links !== linked.includes(b.id));
    check(!stray.length, `round ${round + 1}: the linked rows link back exactly to the rows the task ends up with`, { linked, backs });
  }

  // ── Tags added at once ────────────────────────────────────────────────────────────────────
  const tags = await addProperty(ids.owner, tasks.id, { name: "Tags", type: "multi_select", options: ["red", "green", "blue"] });
  const [red, green, blue] = tags.options.options!.map((o) => o.id);
  const tagged = await createPage(owner, { workspaceId, parentId: tasks.id, title: "Tagged", properties: { [tags.id]: [red] } });
  // Both saw [red]: one adds green, the other blue.
  await Promise.all([
    updateRowProperties(ids.owner, tagged.id, { [tags.id]: [red, green] }, { base: { [tags.id]: [red] } }),
    updateRowProperties(ids.member, tagged.id, { [tags.id]: [red, blue] }, { base: { [tags.id]: [red] } }),
  ]);
  check(same((await valuesOf(tagged.id))[tags.id], [red, green, blue]), "two people adding a tag at once from the same list keep both tags", await valuesOf(tagged.id));
  // One saw [red, green] (not blue yet) and takes red away: blue stays.
  await updateRowProperties(ids.owner, tagged.id, { [tags.id]: [green] }, { base: { [tags.id]: [red, green] } });
  check(same((await valuesOf(tagged.id))[tags.id], [green, blue]), "a removal from an older list takes away only what it removed", await valuesOf(tagged.id));
  // Clearing what one saw keeps the rest; without a base the list is written as given.
  await updateRowProperties(ids.owner, tagged.id, { [tags.id]: null }, { base: { [tags.id]: [green] } });
  check(same((await valuesOf(tagged.id))[tags.id], [blue]), "clearing the list one saw keeps a tag added since", await valuesOf(tagged.id));
  await updateRowProperties(ids.owner, tagged.id, { [tags.id]: [red] });
  check(same((await valuesOf(tagged.id))[tags.id], [red]), "without a base the list is written as given", await valuesOf(tagged.id));

  // A relation limited to one row is written as given even with a base: it holds one row.
  const owners = await addProperty(ids.owner, tasks.id, { name: "Account", type: "relation", relation: { databaseId: clients.id } });
  await updateProperty(ids.owner, owners.id, { oneRow: true });
  await updateRowProperties(ids.owner, tagged.id, { [owners.id]: [x.id] });
  await updateRowProperties(ids.owner, tagged.id, { [owners.id]: [y.id] }, { base: { [owners.id]: [] } });
  check(same((await valuesOf(tagged.id))[owners.id], [y.id]), "a relation limited to one row isn't merged into two", await valuesOf(tagged.id));

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

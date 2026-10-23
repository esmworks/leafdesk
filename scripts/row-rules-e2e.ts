/**
 * End-to-end check of row access against the database: a database's rules giving the people in a
 * person property, or a row's creator, access to the row and the pages under it; restricted rows
 * that only those people (and people with full access to the database) see, in checks and in the
 * database's lists; who may change the setting; rules that stop counting when their property is
 * deleted; a type change refused while a rule names the property; copies of the database keeping
 * the rules; open editors checked again after a row's people change. Creates its own users and
 * workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-rules-e2e.ts
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
const { databaseRowAccess, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, pagesOthersMayEdit, resolvePageAccess } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");
const { addProperty, changePropertyType, deleteProperty, getProperties, listRows, updateRowProperties } = await import("@/server/databases");
const { duplicatePage } = await import("@/server/duplicate");
const { createPage, searchPages } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { getRowAccess, loadRowAccess, setRowAccess } = await import("@/server/row-access");

const RUN = `row-rules-e2e-${Date.now().toString(36)}`;

// Open editors whose access is checked again, by workspace.
const rechecked: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectLostAccess(workspaceId: string) {
    rechecked.push(workspaceId);
  },
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async pageVersion() {
    return "v0";
  },
  async replaceContent() {},
  async appendContent() {},
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

async function levels(pageId: string, ...userIds: string[]) {
  return (await Promise.all(userIds.map(async (id) => (await resolvePageAccess(id, pageId)).level))).join();
}

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice`, bob: `${RUN}-bob`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const { owner, alice, bob, guest } = ids;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
  ]);

  const D = (await createPage({ userId: owner }, { workspaceId, kind: "database", title: "Tasks" })).id;
  await setPagePermission(owner, D, owner, "full");
  const assignee = await addProperty(owner, D, { name: "Assignee", type: "person" });
  await addProperty(owner, D, { name: "Notes", type: "text" });
  const row = async (title: string, by: string, people: string[]) => {
    const id = (await createPage({ userId: by }, { workspaceId, parentId: D, title })).id;
    if (people.length) await updateRowProperties(owner, id, { Assignee: people });
    return id;
  };
  const D1 = await row("Alice's task", owner, [alice]);
  const D2 = await row("Guest's task", owner, [guest]);
  const D3 = await row("Bob's own task", bob, []);
  const S1 = (await createPage({ userId: owner }, { workspaceId, parentId: D1, title: "Under Alice's task" })).id;

  // Rules on a database nobody else may open
  await setPagePermission(owner, D, null, "none");
  check((await levels(D1, alice, bob, guest)) === "none,none,none", "without rules a closed database's rows stay closed");
  await rejects(
    () => setRowAccess(alice, D, { restricted: false, rules: [] }),
    (e) => e instanceof AccessError,
    "only full access to the database changes its row access",
  );
  const notes = (await getProperties(D)).find((p) => p.name === "Notes")!;
  await rejects(
    () => setRowAccess(owner, D, { restricted: false, rules: [{ kind: "person", propertyId: notes.id, level: "edit" }] }),
    (e) => e instanceof PropertyValueError && e.code === "invalidRowAccess",
    "a rule must name a person property",
  );
  rechecked.length = 0;
  await setRowAccess(owner, D, { restricted: false, rules: [{ kind: "person", propertyId: assignee.id, level: "edit" }] });
  check(rechecked.includes(workspaceId), "changing row access checks open editors again");
  check((await levels(D1, alice, bob)) === "edit,none", "the person a row names gets the rule's level on it");
  check((await levels(S1, alice)) === "edit", "…and on the pages under it");
  check((await levels(D2, guest, alice)) === "edit,none", "a guest a row names gets it too");
  check((await levels(D, alice)) === "none", "the database itself stays closed");
  check((await getRowAccess(alice, D1).catch((e) => e)) instanceof AccessError, "the setting is read from the database, not a row");
  const found = await searchPages(alice, "task", { workspaceId });
  check(
    found.some((p) => p.id === D1) && !found.some((p) => p.id === D2 || p.id === D3),
    "search finds the rows a person is named in, and no others",
    found.map((p) => p.title),
  );
  check((await pagesOthersMayEdit(workspaceId, [D1, D3])).has(D1), "a row someone besides the owners may edit through a rule counts as such");
  check(!(await pagesOthersMayEdit(workspaceId, [D3])).has(D3), "…and a row nobody else is named in doesn't");

  // Changing who a row names
  rechecked.length = 0;
  await updateRowProperties(owner, D1, { Assignee: [bob] });
  check((await levels(D1, alice, bob)) === "none,edit", "the access follows the row's people");
  await new Promise((r) => setTimeout(r, 1_300));
  check(rechecked.includes(workspaceId), "…and open editors are checked again once the change settles");

  // Restricted rows of an open database
  await setPagePermission(owner, D, null, "edit");
  await updateRowProperties(owner, D1, { Assignee: [alice] });
  check((await levels(D2, alice, bob)) === "edit,edit", "without restriction everyone sees every row");
  await setRowAccess(owner, D, {
    restricted: true,
    rules: [
      { kind: "person", propertyId: assignee.id, level: "edit" },
      { kind: "creator", level: "view" },
    ],
  });
  check((await levels(D1, alice, bob, owner)) === "edit,none,full", "restricted rows open only to the people they name and full access");
  check((await levels(D3, bob, alice)) === "view,none", "a creator rule opens a row to who created it");
  check((await levels(S1, alice, bob)) === "edit,none", "pages under a restricted row follow it");
  check((await levels(D, alice, bob)) === "edit,edit", "the database itself keeps its access");
  const titles = async (u: string) => (await listRows(u, D)).map((r) => r.title).sort().join("|");
  check((await titles(alice)) === "Alice's task", "the database lists only the rows a person may see", await titles(alice));
  check((await titles(bob)) === "Bob's own task", "…for each person", await titles(bob));
  check((await titles(owner)) === "Alice's task|Bob's own task|Guest's task", "…and every row to full access");
  await setPagePermission(owner, D3, alice, "comment");
  check((await levels(D3, alice)) === "comment", "a row's own sharing still counts on a restricted row");

  // Property changes
  await rejects(
    () => changePropertyType(owner, assignee.id, { type: "text" }),
    (e) => e instanceof PropertyValueError && e.code === "typeChangeNamesPeople",
    "a rule's person property can't change its type",
  );
  const copy = await duplicatePage({ userId: owner }, D, " copy");
  const copied = await loadRowAccess(copy.id);
  const copiedAssignee = (await getProperties(copy.id)).find((p) => p.name === "Assignee")!;
  check(
    copied.restricted && copied.rules.some((r) => r.kind === "person" && r.propertyId === copiedAssignee.id) && copied.rules.some((r) => r.kind === "creator"),
    "a copy of the database keeps the rules, naming its own property",
    copied,
  );
  await deleteProperty(owner, assignee.id);
  check((await levels(D1, alice)) === "none", "a deleted property's rule stops giving access");

  // Turning it off
  await setRowAccess(owner, D, { restricted: false, rules: [] });
  const stored = await db.select().from(databaseRowAccess).where(eq(databaseRowAccess.databaseId, D));
  check(stored.length === 0, "a setting that changes nothing isn't stored");
  check((await levels(D2, bob)) === "edit", "rows follow the database again");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

/**
 * End-to-end check of page permissions against the database: defaults, inheritance, widening and
 * narrowing on subpages, visibility in lists, shared pages showing up as top-level pages, and the
 * guard that keeps someone with full access on every page, what guests can and can't see, rows
 * restricted inside a database, moving pages, what a publication exposes and who may publish,
 * sharing by email, and every read path (UI, MCP tools, collab) keeping a restricted page out of
 * sight. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/access-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, pageInvitation, pagePublication, pageSnapshot, user, workspace, workspaceInvitation, workspaceMember } =
  await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { authorizeCollab } = await import("@/server/collab/authorize");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE } = await import("@/server/mcp/principal");
const { getPageHeaderInfo, listFavorites, setFavorite } = await import("@/server/page-meta");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, getDatabaseSnapshot, getRow, listRows, listWorkspaceDatabases, updateRowProperties } = await import(
  "@/server/databases"
);
const { duplicatePage } = await import("@/server/duplicate");
const {
  getPublishedPage,
  listWorkspacePublications,
  publishBlocker,
  publishPage,
  PublishError,
  revokePublication,
  unpublishPage,
} = await import("@/server/publication");
const { AccessError, getMembership, requirePageAccess, resolvePageAccess } = await import("@/server/access");
const {
  archivePage,
  createPage,
  getBreadcrumbs,
  getPage,
  getSnapshot,
  getTree,
  listChildren,
  listSnapshots,
  listTrash,
  movePage,
  recentPages,
  searchPages,
} = await import("@/server/pages");
const {
  acceptInvitation,
  canInviteGuests,
  listMembers,
  removeMember,
  setMemberRole,
  transferOwnership,
  updateWorkspaceSettings,
  WorkspaceError,
} = await import("@/server/workspaces");
const {
  listPagePermissions,
  PermissionError,
  removePageInvitation,
  removePagePermission,
  setPagePermission,
  sharePageByEmail,
} = await import("@/server/permissions");

const RUN = `access-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
// Open editors whose access is checked again, as [workspace, the users or "everyone"].
const rechecked: string[] = [];
registerCollab({
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectLostAccess(workspaceId: string, userIds?: string[]) {
    rechecked.push(`${workspaceId}:${userIds ? userIds.join(",") : "everyone"}`);
  },
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
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

const isCode = (code: string) => (error: unknown) => error instanceof PermissionError && error.code === code;
const isAccessError = (error: unknown) => error instanceof AccessError;

/** Calls an MCP tool as `userId` with read access, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "access-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  return { isError: Boolean(result.isError), text: result.content[0].text };
}

async function levels(pageId: string, ...userIds: string[]) {
  return Promise.all(userIds.map(async (id) => (await resolvePageAccess(id, pageId)).level));
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
  newcomer: `${RUN}-newcomer`,
};
const emailOf = (id: string) => `${id}@example.test`;
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  // The newcomer has no account yet; it is created when they accept their invitation.
  await db.insert(user).values(userIds.filter((id) => id !== ids.newcomer).map((id) => ({ id, name: id, email: emailOf(id) })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.alice, role: "member" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  // R ─ C ─ G, T ─ P, and the database D with rows D1, D2
  const P = (id: string, parentId: string | null, position: number) => ({
    id: `${RUN}-${id}`,
    workspaceId,
    parentId: parentId && `${RUN}-${parentId}`,
    title: id,
    position,
  });
  await db.insert(page).values([P("R", null, 1), P("T", null, 2), { ...P("D", null, 3), kind: "database" as const }]);
  await db.insert(page).values([P("D1", "D", 1), P("D2", "D", 2)]);
  await db.insert(page).values([P("C", "R", 1), P("P", "T", 1)]);
  await db.insert(page).values([P("G", "C", 1)]);
  const [R, C, G, T, Pg, D, D1, D2] = ["R", "C", "G", "T", "P", "D", "D1", "D2"].map((name) => `${RUN}-${name}`);
  const { owner, alice, bob, guest, outsider, newcomer } = ids;

  // Defaults
  check(
    JSON.stringify(await levels(G, owner, alice, bob, guest, outsider)) === '["full","full","full","none","none"]',
    "without entries members get full access, guests and outsiders none",
  );
  check((await getTree(guest, workspaceId)).length === 0, "a guest's tree starts empty");
  await rejects(
    () => createPage({ userId: guest }, { workspaceId, title: "guest page" }),
    isAccessError,
    "guests can't create top-level pages",
  );
  await rejects(() => listMembers(guest, workspaceId), isAccessError, "guests can't list the workspace's members");

  // The guard
  await rejects(
    () => setPagePermission(owner, R, null, "view"),
    isCode("lastFullAccess"),
    "restricting everyone without keeping a full-access member is refused",
  );
  check((await levels(R, owner))[0] === "full", "the refused change was rolled back");
  await rejects(() => setPagePermission(owner, R, outsider, "view"), isCode("notMember"), "outsiders can't be added");

  // Inheritance
  await setPagePermission(owner, R, owner, "full");
  await setPagePermission(owner, R, null, "view");
  check(
    JSON.stringify(await levels(G, owner, alice, bob)) === '["full","view","view"]',
    "entries on a page apply to its subpages",
  );
  check((await levels(R, guest))[0] === "none", "what everyone gets doesn't reach guests");
  await setPagePermission(owner, R, null, "edit");
  check((await levels(R, bob))[0] === "edit", "setting everyone again updates the same entry");
  rechecked.length = 0;
  await setPagePermission(owner, R, null, "view");
  check(rechecked.join() === `${workspaceId}:everyone`, "narrowing everyone checks everyone's open editors again", rechecked);
  await rejects(() => setPagePermission(alice, R, alice, "full"), isAccessError, "view access can't share");
  await rejects(() => requirePageAccess(alice, C, "edit"), isAccessError, "view access can't edit");

  // Widening and narrowing on a subpage
  await setPagePermission(owner, C, alice, "edit");
  check(JSON.stringify(await levels(G, alice, bob)) === '["edit","view"]', "a subpage entry widens one member");
  rechecked.length = 0;
  await setPagePermission(owner, C, bob, "view");
  check(rechecked.join() === `${workspaceId}:${bob}`, "a member's entry checks their open editors again", rechecked);
  await removePagePermission(owner, C, bob);
  await setPagePermission(owner, G, null, "none");
  check(
    JSON.stringify(await levels(G, owner, alice, bob)) === '["full","edit","none"]',
    "a subpage entry for everyone narrows it, own entries still apply",
  );
  check((await levels(C, bob))[0] === "view", "narrowing a subpage leaves its parent alone");

  // Moving a page changes who inherits access to it
  await rejects(() => movePage(alice, C, null), isAccessError, "edit access can't move a page to another parent");
  rechecked.length = 0;
  await movePage(alice, G, C, 5);
  check(rechecked.length === 0, "edit access can still reorder a page among its siblings, which changes no one's access", rechecked);
  await movePage(owner, G, R);
  check(rechecked.join() === `${workspaceId}:everyone`, "moving a page under another parent checks open editors again", rechecked);
  await movePage(owner, G, C, 5);

  // A publication shows only what its publisher can see
  const token = `${RUN}-token`;
  await db.insert(pagePublication).values({ pageId: R, token, publishedBy: bob });
  const publishedC = await getPublishedPage(token, C);
  check(publishedC?.children.length === 0, "a publication leaves out subpages its publisher can't see", publishedC?.children);
  check((await getPublishedPage(token, G)) === null, "…and won't serve them by id");
  check((await getPublishedPage(token, C)) !== null, "…while serving the ones they can");

  const shared = await listPagePermissions(alice, G);
  check(shared.everyone === "none" && shared.level === "edit", "listing shows the everyone level and the viewer's", shared);
  const aliceEntry = shared.entries.find((e) => e.userId === alice);
  check(aliceEntry?.inherited === true && aliceEntry.sourcePageId === C, "listing marks inherited entries", shared);
  await rejects(() => listPagePermissions(bob, G), isAccessError, "listing needs view access");

  // Visibility in lists
  const bobTree = (await getTree(bob, workspaceId)).map((n) => n.id);
  check(bobTree.includes(C) && !bobTree.includes(G), "the tree hides pages the member can't see", bobTree);

  await setPagePermission(owner, T, owner, "full");
  await setPagePermission(owner, T, null, "none");
  await setPagePermission(owner, Pg, alice, "view");
  const aliceTree = await getTree(alice, workspaceId);
  check(!aliceTree.some((n) => n.id === T), "a private page is hidden from others");
  check(
    aliceTree.find((n) => n.id === Pg)?.parentId === null,
    "a page shared under a hidden parent is top-level in the tree",
    aliceTree,
  );
  const aliceRoots = (await listChildren(alice, workspaceId, null)).map((p) => p.id).sort();
  check(JSON.stringify(aliceRoots) === JSON.stringify([Pg, R, D].sort()), "…and in the top-level list", aliceRoots);
  const crumbs = (await getBreadcrumbs(alice, Pg)).map((c) => c.id);
  check(JSON.stringify(crumbs) === JSON.stringify([Pg]), "breadcrumbs skip hidden ancestors", crumbs);
  check((await levels(Pg, bob))[0] === "none", "the shared page stays hidden from others");

  // Guests see exactly what is shared with them
  await setPagePermission(owner, Pg, guest, "edit");
  const guestTree = await getTree(guest, workspaceId);
  check(
    guestTree.length === 1 && guestTree[0].id === Pg && guestTree[0].parentId === null,
    "a guest's tree holds only the page shared with them, at the top level",
    guestTree,
  );
  const guestRoots = (await listChildren(guest, workspaceId, null)).map((p) => p.id);
  check(JSON.stringify(guestRoots) === JSON.stringify([Pg]), "…and so does their top-level list", guestRoots);
  const guestRecent = (await recentPages(guest, workspaceId, 50)).map((p) => p.id);
  check(JSON.stringify(guestRecent) === JSON.stringify([Pg]), "recent pages show guests only their pages", guestRecent);
  const hits = async (q: string) => (await searchPages(guest, q, { workspaceId })).map((h) => h.id);
  check((await hits("R")).length === 0 && JSON.stringify(await hits("P")) === JSON.stringify([Pg]), "search too");
  check((await levels(Pg, guest))[0] === "edit", "a guest gets the level they were given");

  // Rows restricted inside a database
  await setPagePermission(owner, D2, owner, "full");
  await setPagePermission(owner, D2, null, "none");
  const rowIds = async (id: string) => (await listRows(id, D)).map((r) => r.id);
  check(JSON.stringify(await rowIds(bob)) === JSON.stringify([D1]), "a restricted row is left out of its database");
  check(JSON.stringify(await rowIds(owner)) === JSON.stringify([D1, D2]), "…but not for those it is shared with");

  // Guests can't move pages to the top level
  await setPagePermission(owner, Pg, guest, "full");
  await rejects(() => movePage(guest, Pg, null), isAccessError, "a guest can't move a page to the top level");
  await setPagePermission(owner, Pg, guest, "edit");

  // Sharing by email
  check((await sharePageByEmail(owner, Pg, emailOf(bob).toUpperCase(), "view")).kind === "shared", "a member's email shares right away");
  check((await levels(Pg, bob))[0] === "view", "…with the level asked for");
  await rejects(() => sharePageByEmail(owner, Pg, "not-an-email", "view"), isCode("invalidEmail"), "a bad address is refused");
  await setPagePermission(owner, C, alice, "full");
  await rejects(
    () => sharePageByEmail(alice, C, emailOf(newcomer), "view"),
    isCode("invitesRestricted"),
    "by default only owners bring new people in",
  );

  // Who may invite guests (Settings > Security)
  await rejects(
    () => updateWorkspaceSettings(alice, workspaceId, { guestInvites: "members" }),
    isAccessError,
    "only owners change the workspace's settings",
  );
  await rejects(
    () => updateWorkspaceSettings(owner, workspaceId, { guestInvites: "anyone" as "members" }),
    (error) => error instanceof WorkspaceError && error.code === "invalidSetting",
    "an unknown setting value is refused",
  );
  await updateWorkspaceSettings(owner, workspaceId, { guestInvites: "members" });
  check(
    (await canInviteGuests(alice, workspaceId)) && !(await canInviteGuests(guest, workspaceId)),
    "letting members invite guests reaches members, never guests",
  );
  const byMember = await sharePageByEmail(alice, C, `${RUN}-friend@example.test`, "view");
  check(byMember.kind === "invited", "a member can then share with someone new", byMember);
  await setPagePermission(owner, Pg, guest, "full");
  await rejects(
    () => sharePageByEmail(guest, Pg, `${RUN}-other@example.test`, "view"),
    isCode("invitesRestricted"),
    "a guest with full access still can't bring people in",
  );
  await setPagePermission(owner, Pg, guest, "edit");
  await updateWorkspaceSettings(owner, workspaceId, { guestInvites: "owners" });
  check(!(await canInviteGuests(alice, workspaceId)), "switching back takes it away again");
  await rejects(
    () => updateWorkspaceSettings(owner, workspaceId, { toString: true } as never),
    (error) => error instanceof WorkspaceError && error.code === "invalidSetting",
    "a setting that doesn't exist is refused",
  );

  // Guests' private pages (Settings > Security)
  await updateWorkspaceSettings(owner, workspaceId, { guestPrivatePages: true });
  const own = await createPage({ userId: guest }, { workspaceId, title: "guest's own" });
  check(
    (await levels(own.id, guest, owner, alice, bob)).join() === "full,none,none,none",
    "a guest's top-level page is theirs alone",
  );
  check(
    (await getTree(guest, workspaceId)).some((p) => p.id === own.id) &&
      !(await getTree(owner, workspaceId)).some((p) => p.id === own.id),
    "it shows in their sidebar, not in the owner's",
  );
  const ownDb = await createPage({ userId: guest }, { workspaceId, kind: "database", title: "guest db" });
  check((await levels(ownDb.id, guest, alice)).join() === "full,none", "so does a top-level database");
  const ownCopy = await duplicatePage({ userId: guest }, own.id, " copy");
  check((await levels(ownCopy.id, guest, owner)).join() === "full,none", "a copy of it is private too");
  await setPagePermission(guest, own.id, bob, "view");
  check((await levels(own.id, bob, alice)).join() === "view,none", "they can share it with a member");
  const memberPage = await createPage({ userId: alice }, { workspaceId, title: "member's own" });
  check((await levels(memberPage.id, bob, guest)).join() === "full,none", "a member's top-level page stays open to members");
  await updateWorkspaceSettings(owner, workspaceId, { guestPrivatePages: false });
  await rejects(
    () => createPage({ userId: guest }, { workspaceId, title: "another" }),
    isAccessError,
    "turning it off stops new ones",
  );
  await rejects(() => duplicatePage({ userId: guest }, own.id, " copy"), isAccessError, "…copies included");
  check((await levels(own.id, guest))[0] === "full", "…and leaves the existing ones as they are");

  // Who may publish (Settings > Security)
  const notAllowed = (error: unknown) => error instanceof PublishError && error.code === "notAllowed";
  check((await publishBlocker(alice, memberPage.id)) === null, "by default members with full access may publish");
  const byAlice = await publishPage(alice, memberPage.id);
  check((await publishBlocker(bob, R)) === "needsFullAccess", "view access can't publish");
  check((await publishBlocker(guest, own.id)) === "notAllowed", "guests never publish, even their own pages");
  await rejects(() => publishPage(guest, own.id), notAllowed, "…and publishing is refused");
  await updateWorkspaceSettings(owner, workspaceId, { publishing: "owners" });
  check((await publishBlocker(alice, D)) === "notAllowed", "limiting publishing to owners reaches members");
  await rejects(() => publishPage(alice, D), notAllowed, "…whose publishing is then refused");
  const byOwner = await publishPage(owner, D);
  check((await getPublishedPage(byAlice.token)) !== null, "pages published earlier stay online");
  await unpublishPage(alice, memberPage.id);
  check((await getPublishedPage(byAlice.token)) === null, "…and their full-access members can still take them offline");
  await updateWorkspaceSettings(owner, workspaceId, { publishing: "members" });

  // Owners review every publication, even of pages they can't see
  const hiddenToken = `${RUN}-hidden`;
  await db.insert(pagePublication).values({ pageId: own.id, token: hiddenToken, publishedBy: guest });
  await rejects(() => listWorkspacePublications(alice, workspaceId), isAccessError, "only owners list the publications");
  const publications = await listWorkspacePublications(owner, workspaceId);
  const listedD = publications.find((p) => p.pageId === D);
  const listedOwn = publications.find((p) => p.pageId === own.id);
  check(listedD?.title === "D" && listedD.url === `/s/${byOwner.token}`, "the list names the pages the owner can see", listedD);
  check(listedOwn && listedOwn.title === null && listedOwn.url === null, "…and hides the title and link of the rest", listedOwn);
  await rejects(() => revokePublication(alice, workspaceId, D), isAccessError, "only owners take others' pages offline");
  await revokePublication(owner, workspaceId, own.id);
  check((await getPublishedPage(hiddenToken)) === null, "an owner can take a page they can't see offline");
  check((await sharePageByEmail(owner, Pg, emailOf(outsider), "edit")).kind === "added", "an existing account joins as a guest");
  check(
    (await getMembership(outsider, workspaceId))?.role === "guest" && (await levels(Pg, outsider))[0] === "edit",
    "…and gets the page",
  );
  const invited = await sharePageByEmail(owner, Pg, emailOf(newcomer), "edit");
  check(invited.kind === "invited", "someone without an account is invited", invited);
  const pending = await listPagePermissions(owner, Pg);
  check(
    pending.invitations.some((i) => i.email === emailOf(newcomer) && i.level === "edit"),
    "the page lists whom it waits for",
    pending.invitations,
  );
  check((await listPagePermissions(bob, Pg)).invitations.length === 0, "…but only to those who manage it");
  const [invitation] = await db
    .select({ token: workspaceInvitation.token, role: workspaceInvitation.role })
    .from(workspaceInvitation)
    .where(inArray(workspaceInvitation.email, [emailOf(newcomer)]));
  check(invitation?.role === "guest", "the workspace invitation is for a guest");
  await db.insert(user).values({ id: newcomer, name: newcomer, email: emailOf(newcomer) });
  await acceptInvitation(invitation.token, newcomer, emailOf(newcomer));
  check((await levels(Pg, newcomer))[0] === "edit", "accepting the invitation turns it into access to the page");
  const leftover = await db.select().from(pageInvitation).where(inArray(pageInvitation.email, [emailOf(newcomer)]));
  check(leftover.length === 0, "…and nothing waits any more");

  const later = `${RUN}-later@example.test`;
  await db.insert(workspaceInvitation).values({
    workspaceId,
    email: later,
    role: "member",
    token: `${RUN}-later`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await sharePageByEmail(owner, Pg, later, "view");
  const [kept] = await db.select({ role: workspaceInvitation.role }).from(workspaceInvitation).where(inArray(workspaceInvitation.email, [later]));
  check(kept?.role === "member", "sharing a page doesn't lower a pending invitation's role");
  const stranger = `${RUN}-stranger@example.test`;
  await sharePageByEmail(owner, Pg, stranger, "view");
  await removePageInvitation(owner, Pg, stranger);
  const strangerInvites = await db.select().from(workspaceInvitation).where(inArray(workspaceInvitation.email, [stranger]));
  check(strangerInvites.length === 0, "cancelling the only page a guest was invited to withdraws the invitation");

  // The guard also covers subpages with entries of their own
  await setPagePermission(owner, C, alice, "full");
  await setPagePermission(owner, G, owner, "view");
  check((await levels(G, owner, alice)).join() === "view,full", "a member can hold full access through a parent");
  await rejects(
    () => setPagePermission(owner, C, alice, "edit"),
    isCode("lastFullAccess"),
    "a change that leaves a subpage without full access is refused",
  );
  await rejects(
    () => removePagePermission(owner, C, alice),
    isCode("lastFullAccess"),
    "removing that entry is refused too",
  );

  // Removing entries brings back what is inherited
  await removePagePermission(alice, G, owner);
  await removePagePermission(owner, G, null);
  check((await levels(G, bob))[0] === "view", "removing an entry restores the inherited level");

  // Leak points: a page kept to the owner stays out of every read path, for a member without
  // access and for a guest. Its words must not show up in anything they can read.
  const SECRETS = ["zebracorn", "Secret", "Hidden row", "Back to visible"];
  const [S, S1, S2, S3] = ["S", "S1", "S2", "S3"].map((name) => `${RUN}-${name}`);
  await db
    .insert(page)
    .values({ ...P("S", null, 9), title: "Secret zebracorn", contentText: "the zebracorn plan", contentMarkdown: "the zebracorn plan" });
  await db.insert(page).values([
    { ...P("S1", "S", 1), title: "Secret child", contentText: "zebracorn details" },
    { ...P("S2", "S", 2), title: "Secret trashed" },
    { ...P("S3", "S", 3), title: "Open page" },
  ]);
  await setFavorite(bob, S, true); // starred while it was still open to members
  await setPagePermission(owner, S, owner, "full");
  await setPagePermission(owner, S, null, "none");
  await setPagePermission(owner, S3, bob, "view");
  await setPagePermission(owner, S3, guest, "view");
  await archivePage(owner, S2);
  const [snap] = await db
    .insert(pageSnapshot)
    .values({ pageId: S, title: "Secret zebracorn", ydoc: Buffer.alloc(0), contentMarkdown: "zebracorn", reason: "manual" })
    .returning();
  const SD = (await createPage({ userId: owner }, { workspaceId, parentId: S, kind: "database", title: "Secret db" })).id;
  const SD1 = (await createPage({ userId: owner }, { workspaceId, parentId: SD, title: "Hidden row" })).id;
  const VD = (await createPage({ userId: owner }, { workspaceId, kind: "database", title: "Visible db" })).id;
  await setPagePermission(owner, VD, guest, "edit");
  await addProperty(owner, VD, {
    name: "Links",
    type: "relation",
    relation: { databaseId: SD, twoWay: true, pairedName: "Back to visible" },
  });
  const VR = (await createPage({ userId: owner }, { workspaceId, parentId: VD, title: "Visible row" })).id;
  await updateRowProperties(owner, VR, { Links: [SD1] });
  check(
    JSON.stringify(await getDatabaseSnapshot(owner, VD)).includes("Hidden row"),
    "the owner sees the linked row (the test setup works)",
  );
  const hidden = [S, S1, S2, SD, SD1];

  for (const [who, u] of [["member", bob], ["guest", guest]] as const) {
    const idsOf = (list: { id: string }[]) => list.map((p) => p.id);
    const leaked = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return [...SECRETS, ...hidden.map((id) => JSON.stringify(id))].filter((needle) => text.includes(needle));
    };
    const reads = {
      search: await searchPages(u, "zebracorn", { workspaceId }),
      searchTitle: await searchPages(u, "Secret", { workspaceId }),
      tree: await getTree(u, workspaceId),
      top: await listChildren(u, workspaceId, null),
      recent: await recentPages(u, workspaceId, 50),
      favorites: await listFavorites(u, workspaceId),
      trash: await listTrash(u, workspaceId),
      databases: await listWorkspaceDatabases(u, workspaceId),
      breadcrumbs: await getBreadcrumbs(u, S3),
      openPage: await getPage(u, S3),
      visibleDb: await getDatabaseSnapshot(u, VD),
      visibleRows: await listRows(u, VD),
      visibleRow: await getRow(u, VR),
    };
    // Ids without titles are allowed in two places: the page itself names its real parent (moving
    // it decides from that whether access changes), and a row's relation values keep links to rows
    // they can't see (so editing the cell keeps them), as does the schema the related database.
    const idsAllowed = new Set(["openPage", "visibleDb", "visibleRows", "visibleRow"]);
    for (const [name, value] of Object.entries(reads)) {
      const found = idsAllowed.has(name) ? SECRETS.filter((w) => JSON.stringify(value).includes(w)) : leaked(value);
      check(!found.length, `${who}: ${name} shows nothing restricted`, found);
    }
    check(idsOf(reads.search).length === 0, `${who}: search finds no restricted text`);
    const openHit = (await searchPages(u, "Open page", { workspaceId })).find((h) => h.id === S3);
    check(openHit?.parentId === null, `${who}: a search hit doesn't name a parent they can't see`, openHit);
    const relation = Object.values(reads.visibleDb.relations)[0];
    check(
      relation?.database === null && relation.rows.length === 0 && relation.pairedName === null,
      `${who}: a relation to a database they can't see names neither it nor its rows`,
      relation,
    );
    await rejects(
      () => updateRowProperties(u, VR, { Links: ["Hidden row"] }),
      (error) => (error as { code?: string }).code === "invalidRelation",
      `${who}: a hidden row can't be found by its title`,
    );

    for (const [name, read] of [
      ["page", () => getPage(u, S)],
      ["subpage", () => getPage(u, S1)],
      ["breadcrumbs", () => getBreadcrumbs(u, S1)],
      ["subpages", () => listChildren(u, workspaceId, S)],
      ["page history", () => listSnapshots(u, S)],
      ["a version", () => getSnapshot(u, snap.id)],
      ["page header", () => getPageHeaderInfo(u, S)],
      ["sharing", () => listPagePermissions(u, S)],
      ["database", () => getDatabaseSnapshot(u, SD)],
      ["database rows", () => listRows(u, SD)],
      ["row", () => getRow(u, SD1)],
      ["live page", () => authorizeCollab(u, { kind: "page", id: S })],
      ["live database", () => authorizeCollab(u, { kind: "db", id: SD })],
    ] as const) {
      await rejects(read, isAccessError, `${who}: ${name} is refused`);
    }
    check((await authorizeCollab(u, { kind: "page", id: S3 })).readOnly, `${who}: a page they may view opens read-only`);

    // The same through the MCP tools an AI app uses
    const tools: [string, Record<string, unknown>][] = [
      ["search", { query: "zebracorn" }],
      ["search", { query: "Secret" }],
      ["list_pages", { workspace_id: workspaceId }],
      ["list_recent_pages", { workspace_id: workspaceId }],
      ["list_trash", { workspace_id: workspaceId }],
      ["get_page", { page_id: S3 }],
      ["get_database", { database_id: VD }],
      ["query_database", { database_id: VD }],
      ["get_page", { page_id: VR }],
    ];
    for (const [tool, args] of tools) {
      const r = await callTool(u, tool, args);
      check(!r.isError && !leaked(r.text).length, `${who}: MCP ${tool} ${JSON.stringify(args)} shows nothing restricted`, r.text);
    }
    for (const [tool, args] of [
      ["get_page", { page_id: S }],
      ["list_pages", { workspace_id: workspaceId, parent_id: S }],
      ["list_page_history", { page_id: S }],
      ["get_page_version", { version_id: snap.id }],
      ["query_database", { database_id: SD }],
    ] as const) {
      const r = await callTool(u, tool, args);
      check(r.isError && !leaked(r.text).length, `${who}: MCP ${tool} on a restricted page is refused`, r.text);
    }
  }
  check((await callTool(guest, "list_users", { workspace_id: workspaceId })).isError, "guest: MCP list_users is refused");
  await rejects(
    () => authorizeCollab(`${RUN}-nobody`, { kind: "ws", id: workspaceId }),
    isAccessError,
    "someone outside the workspace gets none of its live signals",
  );

  // An owner made a member keeps only what members get: their open editors are checked again
  await setMemberRole(owner, workspaceId, bob, "owner");
  rechecked.length = 0;
  await setMemberRole(owner, workspaceId, bob, "member");
  check(rechecked.join() === `${workspaceId}:${bob}`, "an owner made a member has their open editors checked again", rechecked);
  rechecked.length = 0;
  await transferOwnership(owner, workspaceId, bob);
  check(rechecked.join() === `${workspaceId}:${owner}`, "handing over the workspace checks the former owner's open editors again", rechecked);
  await transferOwnership(bob, workspaceId, owner);

  // Ownership goes to members only
  await rejects(
    () => transferOwnership(owner, workspaceId, guest),
    (error) => error instanceof WorkspaceError && error.code === "transferToGuest",
    "ownership can't be handed to a guest",
  );

  // Nobody leaving strands a page: what only they managed passes to an owner
  await removeMember(owner, workspaceId, guest);
  check(
    (await levels(own.id, owner, bob, alice)).join() === "full,view,none",
    "removing a guest hands their private pages to the owner who removed them, and to nobody else",
  );
  check((await levels(ownDb.id, owner, alice)).join() === "full,none", "…their databases too");
  const solo = await createPage({ userId: alice }, { workspaceId, title: "alice's" });
  await setPagePermission(alice, solo.id, alice, "full");
  await setPagePermission(alice, solo.id, null, "none");
  check((await levels(solo.id, alice, owner, bob)).join() === "full,none,none", "a member can keep a page to themselves");
  await removeMember(alice, workspaceId, alice);
  check((await levels(Pg, alice))[0] === "none", "grants stop applying once the member leaves");
  check((await levels(solo.id, owner, bob)).join() === "full,none", "a member who leaves hands it to the oldest owner");
  const bobs = await createPage({ userId: bob }, { workspaceId, title: "bob's" });
  await setPagePermission(bob, bobs.id, bob, "full");
  await setPagePermission(bob, bobs.id, null, "none");
  await setMemberRole(owner, workspaceId, bob, "guest");
  check((await levels(bobs.id, bob, owner)).join() === "full,none", "a member made guest keeps their own pages");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

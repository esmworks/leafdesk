/**
 * End-to-end check of member groups against the database: who may manage and see groups, who can
 * be in one (owners and members, never guests), page entries for groups (inherited, overridden on
 * a subpage, the highest level winning across a person's own entry, their groups and "everyone"),
 * teamspace membership through a group (visibility, access, leaving, roles, member counts), what
 * happens when access goes away (open editors dropped, stranded pages handed over, the last full
 * access kept), leaving the workspace or becoming a guest, duplicates and restored pages keeping
 * group entries, a workspace with group entries only, and the MCP tool and REST endpoint that list
 * groups. Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/groups-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { memberGroupMember, page, pageGroupPermission, pagePermission, teamspace, user, workspace, workspaceMember } = await import(
  "@/db/schema"
);
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE } = await import("@/server/mcp/principal");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { archivePage, createPage, getTree, restorePage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { listPagePermissions, PermissionError, removePageGroupPermission, removePagePermission, setPageGroupPermission, setPagePermission } =
  await import("@/server/permissions");
const { removeMember, setMemberRole } = await import("@/server/workspaces");
const { handleApiRequest } = await import("@/server/api");
const { createApiToken } = await import("@/server/api/tokens");
const { addGroupMembers, createGroup, deleteGroup, GroupError, groupsByMember, listGroups, removeGroupMember, renameGroup } =
  await import("@/server/groups");
const {
  addTeamspaceGroups,
  addTeamspaceMembers,
  createTeamspace,
  leaveTeamspace,
  listTeamspaceGroups,
  listTeamspaceMembers,
  listTeamspaces,
  removeTeamspaceGroup,
  removeTeamspaceMember,
  setTeamspaceRole,
  TeamspaceError,
  teamspacesByMember,
} = await import("@/server/teamspaces");

const RUN = `groups-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
const lost: { workspaceId: string; userIds: string[] }[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async disconnectLostAccess(workspaceId: string, userIds: string[]) {
    lost.push({ workspaceId, userIds });
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

const groupCode = (code: string) => (error: unknown) => error instanceof GroupError && error.code === code;
const teamspaceCode = (code: string) => (error: unknown) => error instanceof TeamspaceError && error.code === code;
const permissionCode = (code: string) => (error: unknown) => error instanceof PermissionError && error.code === code;
const isAccessError = (error: unknown) => error instanceof AccessError;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "groups-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

async function levels(pageId: string, ...userIds: string[]) {
  return (await Promise.all(userIds.map(async (id) => (await resolvePageAccess(id, pageId)).level))).join();
}

const lostFor = (userId: string) => lost.some((l) => l.userIds.includes(userId));

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  dave: `${RUN}-dave`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;
const bareWs = `${RUN}-ws3`;
const { owner, alice, bob, carol, dave, guest, outsider } = ids;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWs, name: `${RUN} other` },
    { id: bareWs, name: `${RUN} bare` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: dave, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
    { workspaceId: otherWs, userId: alice, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));

  // ── Managing groups ──────────────────────────────────────────────────────────────────────────
  check((await listGroups(alice, workspaceId)).length === 0, "a new workspace has no groups");
  const design = await createGroup(owner, workspaceId, "  Design  ", [alice, bob]);
  check(design.name === "Design", "an owner creates a group, its name cleaned up");
  await rejects(() => createGroup(owner, workspaceId, "design"), groupCode("nameTaken"), "group names are unique in a workspace, whatever the case");
  await rejects(() => createGroup(owner, workspaceId, "   "), groupCode("nameRequired"), "a group needs a name");
  await rejects(() => createGroup(alice, workspaceId, "Mine"), isAccessError, "members can't create groups");
  await rejects(() => createGroup(owner, workspaceId, "With guest", [guest]), groupCode("notMember"), "guests can't be put in a new group");
  check((await listGroups(owner, workspaceId)).every((g) => g.name !== "With guest"), "…and the refused group isn't created");
  await rejects(() => addGroupMembers(owner, design.id, [guest]), groupCode("notMember"), "guests can't be added to a group");
  await rejects(() => addGroupMembers(owner, design.id, [outsider]), groupCode("notMember"), "people outside the workspace can't be added");
  await rejects(() => addGroupMembers(alice, design.id, [carol]), isAccessError, "members can't change who is in a group");
  await rejects(() => renameGroup(alice, design.id, "Ours"), isAccessError, "members can't rename a group");
  await rejects(() => deleteGroup(alice, design.id), isAccessError, "members can't delete a group");
  await rejects(() => addGroupMembers(outsider, design.id, [outsider]), isAccessError, "another workspace's owner can't touch the group");
  const leads = await createGroup(owner, workspaceId, "Leads", [alice]);
  await rejects(() => renameGroup(owner, leads.id, "DESIGN"), groupCode("nameTaken"), "a rename can't take another group's name");
  await renameGroup(owner, leads.id, "Team leads");
  const listed = await listGroups(bob, workspaceId);
  check(
    listed.map((g) => g.name).join() === "Design,Team leads" && listed[0].memberCount === 2,
    "members see the groups by name with who is in them",
    listed.map((g) => ({ name: g.name, count: g.memberCount })),
  );
  await rejects(() => listGroups(guest, workspaceId), isAccessError, "guests don't see groups");
  const byMember = await groupsByMember(owner, workspaceId);
  check(
    byMember.get(alice)?.map((g) => g.name).join() === "Design,Team leads" && !byMember.has(carol),
    "the members list shows each person's groups",
  );
  const theirs = await createGroup(outsider, otherWs, "Theirs", [alice]);

  // ── Sharing pages with groups ───────────────────────────────────────────────────────────────
  const secret = await createPage({ userId: owner }, { workspaceId, title: `${RUN} secret`, teamspaceId: null });
  const child = await createPage({ userId: owner }, { workspaceId, parentId: secret.id, title: `${RUN} secret child` });
  check((await levels(secret.id, owner, alice, bob, carol)) === "full,none,none,none", "a private page starts closed to everyone else");
  await setPageGroupPermission(owner, secret.id, design.id, "edit");
  check((await levels(secret.id, alice, bob, carol, guest)) === "edit,edit,none,none", "sharing with a group gives everyone in it that level");
  check((await levels(child.id, alice, bob)) === "edit,edit", "…on its subpages too");
  check((await getTree(bob, workspaceId)).some((n) => n.id === secret.id), "…and puts the page in their sidebar");
  const panel = await listPagePermissions(owner, secret.id);
  check(
    panel.groups.length === 1 && panel.groups[0].name === "Design" && panel.groups[0].memberCount === 2 && !panel.groups[0].inherited,
    "the sharing panel lists the group with its size",
    panel.groups,
  );
  check((await listPagePermissions(owner, child.id)).groups[0]?.inherited === true, "…and shows it inherited on a subpage");
  await rejects(() => setPageGroupPermission(alice, secret.id, design.id, "full"), isAccessError, "sharing with a group needs full access");
  await rejects(() => setPageGroupPermission(owner, secret.id, theirs.id, "view"), isAccessError, "another workspace's group can't be given a page");
  await setPageGroupPermission(owner, secret.id, leads.id, "full");
  check((await levels(secret.id, alice, bob)) === "full,edit", "someone in several groups gets the highest of them");
  await setPagePermission(owner, secret.id, bob, "view");
  check((await levels(secret.id, bob)) === "edit", "their own lower entry doesn't take a group's level away");
  await setPagePermission(owner, secret.id, bob, "full");
  check((await levels(secret.id, bob)) === "full", "…and a higher one of their own wins over the group's");
  await removePagePermission(owner, secret.id, bob);
  lost.length = 0;
  await setPageGroupPermission(owner, child.id, design.id, "none");
  check((await levels(child.id, bob, alice)) === "none,full", "a group's 'no access' on a subpage stops what it inherits (other groups still count)");
  await setPageGroupPermission(owner, child.id, design.id, "view");
  check((await levels(child.id, bob)) === "view", "…and another level there replaces it");
  lost.length = 0;
  await setPageGroupPermission(owner, secret.id, design.id, "comment");
  check(lostFor(bob) && lostFor(alice), "lowering a group's level checks its members' open editors again");
  lost.length = 0;
  await removePageGroupPermission(owner, secret.id, design.id);
  check((await levels(secret.id, bob)) === "none" && (await levels(child.id, bob)) === "view", "removing the entry takes the page away (the subpage's own entry stays)");
  check(lostFor(bob), "…and drops the group's open editors that lost access");

  // A page only a group can manage.
  const groupOwned = await createPage({ userId: owner }, { workspaceId, title: `${RUN} group owned`, teamspaceId: null });
  await setPageGroupPermission(owner, groupOwned.id, design.id, "full");
  await removePagePermission(owner, groupOwned.id, owner);
  check((await levels(groupOwned.id, owner, alice, bob)) === "none,full,full", "a group can be the one managing a page");
  await rejects(
    () => removePageGroupPermission(alice, groupOwned.id, design.id),
    permissionCode("lastFullAccess"),
    "the group's full access can't be removed while nobody else has it",
  );
  await rejects(
    () => setPageGroupPermission(bob, groupOwned.id, design.id, "edit"),
    permissionCode("lastFullAccess"),
    "…nor lowered",
  );
  await removeGroupMember(owner, design.id, alice);
  check((await levels(groupOwned.id, alice, bob, owner)) === "none,full,none", "someone taken out of a group loses what the group gave them");
  check(lostFor(alice), "…and their open editors are checked again");
  await removeGroupMember(owner, design.id, bob);
  check((await levels(groupOwned.id, owner)) === "full", "a page nobody can manage after that passes to the owner who did it");

  // ── Duplicates and restored pages keep group entries ────────────────────────────────────────
  await addGroupMembers(owner, design.id, [alice, bob]);
  const shared = await createPage({ userId: owner }, { workspaceId, title: `${RUN} shared`, teamspaceId: null });
  const sub = await createPage({ userId: owner }, { workspaceId, parentId: shared.id, title: `${RUN} shared sub` });
  await setPageGroupPermission(owner, shared.id, design.id, "comment");
  const restricted = await createPage({ userId: owner }, { workspaceId, title: `${RUN} restricted`, teamspaceId: general.id });
  await setPagePermission(owner, restricted.id, owner, "full");
  await setPagePermission(owner, restricted.id, null, "none");
  await setPageGroupPermission(owner, restricted.id, design.id, "comment");
  const copy = await duplicatePage({ userId: owner }, restricted.id, " (copy)");
  check((await levels(copy.id, bob, carol)) === "comment,none", "a duplicate keeps the page's group entries");
  const privateCopy = await duplicatePage({ userId: owner }, shared.id, " (copy)");
  check((await levels(privateCopy.id, bob, owner)) === "none,full", "…but a copy of a private page is private to whoever made it, as with people");
  await archivePage(owner, shared.id);
  await restorePage(owner, sub.id);
  const [lifted] = await db.select({ parentId: page.parentId }).from(page).where(eq(page.id, sub.id));
  check(lifted.parentId === null && (await levels(sub.id, bob, carol)) === "comment,none", "a page restored out of a trashed parent keeps what its group had");

  // ── Teamspaces through groups ───────────────────────────────────────────────────────────────
  const closed = await createTeamspace(owner, workspaceId, { name: `${RUN} Closed`, access: "closed" });
  const hidden = await createTeamspace(owner, workspaceId, { name: `${RUN} Hidden`, access: "private" });
  const clPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} closed page`, teamspaceId: closed.id });
  const hiPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} hidden page`, teamspaceId: hidden.id });
  check((await levels(clPage.id, alice, bob, carol)) === "none,none,none", "a closed teamspace's pages are shut to people outside it");
  check(!(await listTeamspaces(bob, workspaceId)).some((t) => t.id === hidden.id), "a private teamspace is hidden from people outside it");
  await rejects(() => addTeamspaceGroups(bob, closed.id, [design.id]), isAccessError, "only those who manage a teamspace add groups to it");
  await rejects(() => addTeamspaceGroups(owner, general.id, [design.id]), teamspaceCode("everyoneIn"), "a default teamspace needs no groups");
  await rejects(() => addTeamspaceGroups(owner, closed.id, [theirs.id]), isAccessError, "another workspace's group can't join");
  await addTeamspaceGroups(owner, closed.id, [design.id]);
  await addTeamspaceGroups(owner, hidden.id, [design.id]);
  check((await levels(clPage.id, alice, bob, carol)) === "full,full,none", "a group in a teamspace puts its members in it");
  check((await levels(hiPage.id, bob)) === "full", "…a private one too");
  const bobsView = (await listTeamspaces(bob, workspaceId)).find((t) => t.id === hidden.id);
  check(bobsView?.joined && bobsView.viaGroup && !bobsView.canLeave, "…which they now see, in it through the group, leaving with the group", bobsView);
  check(bobsView?.memberCount === 3, "member counts include the group's members", bobsView?.memberCount);
  check((await getTree(bob, workspaceId)).some((n) => n.id === clPage.id), "the teamspace's pages show up in their sidebar");
  check(
    (await teamspacesByMember(owner, workspaceId)).get(bob)?.some((t) => t.id === closed.id),
    "the members list shows the teamspaces people are in through groups",
  );
  const people = await listTeamspaceMembers(owner, closed.id);
  const bobRow = people.find((p) => p.userId === bob);
  check(bobRow && !bobRow.direct && bobRow.groups.join() === "Design", "the teamspace's member list says who is in it through which group", people);
  check((await listTeamspaceGroups(bob, closed.id)).map((g) => g.name).join() === "Design", "…and lists its groups");
  const floors = (await listPagePermissions(owner, clPage.id)).floors;
  check(floors[bob] === "full" && floors[carol] === "none", "the sharing panel counts group members as in the teamspace", floors);
  await rejects(() => removeTeamspaceMember(owner, closed.id, bob), teamspaceCode("inGroup"), "someone in through a group isn't removed one by one");
  await rejects(() => leaveTeamspace(bob, closed.id), teamspaceCode("inGroup"), "…nor leaves on their own");
  await setTeamspaceRole(owner, closed.id, alice, "owner");
  check(
    (await listTeamspaceMembers(owner, closed.id)).find((p) => p.userId === alice)?.direct === true,
    "making a group member an owner gives them a place of their own",
  );
  await addTeamspaceMembers(owner, closed.id, [carol]);
  lost.length = 0;
  await removeTeamspaceGroup(owner, closed.id, design.id);
  check((await levels(clPage.id, alice, bob, carol)) === "full,none,full", "taking the group out leaves only those in it on their own");
  check(lostFor(bob), "…and drops the open editors of those who lost its pages");

  // ── Leaving the workspace, becoming a guest ─────────────────────────────────────────────────
  await addGroupMembers(owner, leads.id, [dave]);
  await setPageGroupPermission(owner, secret.id, leads.id, "full");
  check((await levels(secret.id, dave)) === "full", "dave gets the page through Team leads");
  await setMemberRole(owner, workspaceId, dave, "guest");
  const daveGroups = await db.select().from(memberGroupMember).where(eq(memberGroupMember.userId, dave));
  check(daveGroups.length === 0, "someone made guest leaves every group");
  check((await levels(secret.id, dave)) === "none", "…and loses what the groups gave them");
  await rejects(() => addGroupMembers(owner, leads.id, [dave]), groupCode("notMember"), "…and can't be put back while a guest");
  await setMemberRole(owner, workspaceId, dave, "member");
  await addGroupMembers(owner, leads.id, [dave]);
  // Bypassing the app: even a group row for a guest gives nothing.
  await db.update(workspaceMember).set({ role: "guest" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, dave)));
  check((await levels(secret.id, dave)) === "none", "the access rule ignores groups for guests");
  await db.update(workspaceMember).set({ role: "member" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, dave)));
  await removeMember(owner, workspaceId, bob);
  const bobGroups = await db.select().from(memberGroupMember).where(eq(memberGroupMember.userId, bob));
  check(bobGroups.length === 0, "someone removed from the workspace is out of its groups");
  check(
    (await db.select().from(memberGroupMember).where(eq(memberGroupMember.userId, alice))).length === 3,
    "…people's groups in other workspaces stay",
  );

  // ── Deleting a group ────────────────────────────────────────────────────────────────────────
  const solo = await createPage({ userId: owner }, { workspaceId, title: `${RUN} solo`, teamspaceId: null });
  await setPageGroupPermission(owner, solo.id, leads.id, "full");
  await removePagePermission(owner, solo.id, owner);
  lost.length = 0;
  await deleteGroup(owner, leads.id);
  check(
    (await db.select().from(pageGroupPermission).where(eq(pageGroupPermission.groupId, leads.id))).length === 0,
    "deleting a group removes its page entries",
  );
  check((await levels(secret.id, alice, dave)) === "none,none", "…and what it gave its members");
  check((await levels(solo.id, owner)) === "full", "…pages only it could manage pass to the owner who deleted it");
  check(lostFor(alice) && lostFor(dave), "…and its members' open editors are checked again");

  // ── A workspace with group entries only (no named or "everyone" entries) ────────────────────
  await db.insert(workspaceMember).values([
    { workspaceId: bareWs, userId: owner, role: "owner" },
    { workspaceId: bareWs, userId: carol, role: "member" },
  ]);
  const bareSpace = await createTeamspace(owner, bareWs, { name: `${RUN} bare closed`, access: "closed" });
  const barePage = await createPage({ userId: owner }, { workspaceId: bareWs, title: `${RUN} bare page`, teamspaceId: bareSpace.id });
  const bareGroup = await createGroup(owner, bareWs, "Readers", [carol]);
  await setPageGroupPermission(owner, barePage.id, bareGroup.id, "view");
  const named = await db.select({ n: sql<number>`count(*)::int` }).from(pagePermission).where(eq(pagePermission.workspaceId, bareWs));
  check(named[0].n === 0, "sanity: the bare workspace has no page_permission rows");
  check((await levels(barePage.id, carol, owner)) === "view,full", "group entries count where no page has any other entry");

  // ── MCP and REST ────────────────────────────────────────────────────────────────────────────
  const mcp = await callTool(alice, "list_groups", { workspace_id: workspaceId });
  check(
    !mcp.isError && mcp.data.groups.length === 1 && mcp.data.groups[0].name === "Design" && mcp.data.groups[0].members.length === 1,
    "MCP list_groups lists the workspace's groups and who is in them",
    mcp,
  );
  const mcpGuest = await callTool(guest, "list_groups", { workspace_id: workspaceId });
  check(mcpGuest.isError, "…and refuses guests", mcpGuest.text);
  const ownerToken = (await createApiToken(owner, { name: RUN, scopes: ["pages:read"] })).secret;
  const guestToken = (await createApiToken(guest, { name: RUN, scopes: ["pages:read"] })).secret;
  const boundToken = (await createApiToken(owner, { name: RUN, scopes: ["pages:read"], workspaceId: bareWs })).secret;
  const api = async (token: string, path: string) => {
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }));
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const rest = await api(ownerToken, `/workspaces/${workspaceId}/groups`);
  check(rest.status === 200 && rest.data.groups[0]?.name === "Design", "REST lists groups", rest);
  check((await api(guestToken, `/workspaces/${workspaceId}/groups`)).status === 404, "…not to guests");
  check((await api(boundToken, `/workspaces/${workspaceId}/groups`)).status === 404, "…nor to a token bound to another workspace");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs, bareWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

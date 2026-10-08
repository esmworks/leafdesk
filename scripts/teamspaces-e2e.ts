/**
 * End-to-end check of teamspaces against the database: the General teamspace every workspace
 * gets, who sees and gets into default / open / closed / private teamspaces, joining and leaving,
 * who may create and manage them, access changes (including to and from default), archiving,
 * where new pages land, moving pages between teamspaces and private pages (sidebar and MCP), the
 * restore lift, leaving the workspace, and private pages staying out of every read path (tree,
 * search, mentions, export, sharing panel, MCP). Creates its own users and workspace and deletes
 * them afterwards.
 *
 *   pnpm tsx scripts/teamspaces-e2e.ts
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
const { page, pagePermission, teamspace, teamspaceMember, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { archivePage, createPage, getSidebar, getTree, listChildren, movePage, restorePage, searchPages } = await import(
  "@/server/pages"
);
const { duplicatePage } = await import("@/server/duplicate");
const { mentionCandidates } = await import("@/server/mentions");
const { planExport } = await import("@/server/export");
const { listPagePermissions, setPagePermission } = await import("@/server/permissions");
const { removeMember, setMemberRole, updateWorkspaceSettings } = await import("@/server/workspaces");
const { handleApiRequest } = await import("@/server/api");
const { createApiToken } = await import("@/server/api/tokens");
const {
  addTeamspaceMembers,
  canCreateTeamspace,
  createTeamspace,
  getTeamspace,
  joinTeamspace,
  leaveTeamspace,
  listTeamspaceMembers,
  listTeamspaces,
  removeTeamspaceMember,
  setTeamspaceArchived,
  setTeamspaceRole,
  sidebarTeamspaces,
  teamspaceLabel,
  TeamspaceError,
  teamspacesByMember,
  updateTeamspace,
} = await import("@/server/teamspaces");

const RUN = `teamspaces-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
const disconnected: { teamspaceId: string; userIds?: string[] }[] = [];
// Open editors whose access is checked again, as [workspace, the users or "everyone"].
const rechecked: string[] = [];
registerCollab({
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace(teamspaceId: string, userIds?: string[]) {
    disconnected.push({ teamspaceId, userIds });
  },
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectLostAccess(workspaceId: string, userIds?: string[]) {
    rechecked.push(`${workspaceId}:${userIds ? userIds.join(",") : "everyone"}`);
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

const isCode = (code: string) => (error: unknown) => error instanceof TeamspaceError && error.code === code;
const isAccessError = (error: unknown) => error instanceof AccessError;
const anyError = () => true;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>, write = false) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: write ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE] });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "teamspaces-e2e", version: "1" } },
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

async function spaceOf(pageId: string) {
  const [row] = await db.select({ teamspaceId: page.teamspaceId }).from(page).where(eq(page.id, pageId));
  return row?.teamspaceId ?? null;
}

async function rowsOf(teamspaceId: string) {
  const rows = await db
    .select({ userId: teamspaceMember.userId, role: teamspaceMember.role })
    .from(teamspaceMember)
    .where(eq(teamspaceMember.teamspaceId, teamspaceId));
  return new Map(rows.map((r) => [r.userId, r.role]));
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  dave: `${RUN}-dave`,
  guest: `${RUN}-guest`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const { owner, alice, bob, carol, dave, guest } = ids;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
  ]);

  // ── The General teamspace ──────────────────────────────────────────────────────────────────
  const generals = await db.select().from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  check(generals.length === 1 && generals[0].access === "default", "a new workspace gets one default teamspace", generals);
  const general = generals[0].id;
  check((await sidebarTeamspaces(bob, workspaceId)).some((t) => t.id === general), "every member is in the default teamspace");
  check(
    (await listTeamspaces(guest, workspaceId).catch(() => [])).length === 0,
    "guests see no teamspaces",
  );
  const genPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} general page` });
  check((await spaceOf(genPage.id)) === general, "a top-level page lands in the default teamspace when none is named");
  check((await levels(genPage.id, owner, bob, guest)) === "full,full,none", "default teamspace pages: members full, guests none");
  await rejects(() => leaveTeamspace(bob, general), isCode("cannotLeaveDefault"), "nobody leaves a default teamspace");
  await db.insert(workspaceMember).values({ workspaceId, userId: dave, role: "member" });
  check((await levels(genPage.id, dave)) === "full", "someone joining the workspace is in the default teamspace right away");

  // ── Creating teamspaces ────────────────────────────────────────────────────────────────────
  const open = await createTeamspace(owner, workspaceId, { name: `${RUN} Open`, access: "open" });
  const closed = await createTeamspace(owner, workspaceId, { name: `${RUN} Closed`, access: "closed" });
  const secret = await createTeamspace(owner, workspaceId, { name: `${RUN} Secret`, access: "private" });
  check((await rowsOf(open.id)).get(owner) === "owner", "the creator owns the new teamspace");
  await updateWorkspaceSettings(owner, workspaceId, { teamspaceCreation: "owners" });
  check(!(await canCreateTeamspace(alice, workspaceId)), "with the owners-only setting members can't create teamspaces");
  await rejects(
    () => createTeamspace(alice, workspaceId, { name: "nope", access: "open" }),
    isCode("creationRestricted"),
    "…and creating one is refused",
  );
  await updateWorkspaceSettings(owner, workspaceId, { teamspaceCreation: "members" });
  await rejects(
    () => createTeamspace(alice, workspaceId, { name: "everyone's", access: "default" }),
    isCode("ownersOnly"),
    "only workspace owners create default teamspaces",
  );
  await rejects(() => createTeamspace(guest, workspaceId, { name: "g", access: "open" }), anyError, "guests can't create teamspaces");
  const alicePriv = await createTeamspace(alice, workspaceId, { name: `${RUN} Alice private`, access: "private" });
  await rejects(() => createTeamspace(alice, workspaceId, { name: " ", access: "open" }), isCode("nameRequired"), "a name is required");

  // ── Who sees which teamspace ───────────────────────────────────────────────────────────────
  const bobSees = new Set((await listTeamspaces(bob, workspaceId)).map((t) => t.id));
  check(
    bobSees.has(general) && bobSees.has(open.id) && bobSees.has(closed.id) && !bobSees.has(secret.id) && !bobSees.has(alicePriv.id),
    "members see default, open and closed teamspaces but not private ones they aren't in",
  );
  const ownerSees = new Set((await listTeamspaces(owner, workspaceId)).map((t) => t.id));
  check(!ownerSees.has(alicePriv.id), "a private teamspace stays hidden even from workspace owners outside it");
  await rejects(() => getTeamspace(owner, alicePriv.id), isAccessError, "…getting it reads as not found");
  check((await teamspaceLabel(owner, alicePriv.id)) === null, "…and it isn't named to them");
  await rejects(() => listTeamspaceMembers(bob, secret.id), isAccessError, "who is in a private teamspace stays hidden");
  const openForBob = (await listTeamspaces(bob, workspaceId)).find((t) => t.id === open.id)!;
  check(openForBob.canJoin && !openForBob.joined && !openForBob.canManage, "bob can join the open teamspace but not manage it");

  // ── Page access by teamspace ───────────────────────────────────────────────────────────────
  const opPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} open page`, teamspaceId: open.id });
  const opChild = await createPage({ userId: owner }, { workspaceId, parentId: opPage.id, title: `${RUN} open child` });
  const clPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} closed page`, teamspaceId: closed.id });
  const sePage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} secret page`, teamspaceId: secret.id });
  const prPage = await createPage({ userId: owner }, { workspaceId, title: `${RUN} private page`, teamspaceId: null });
  const prChild = await createPage({ userId: owner }, { workspaceId, parentId: prPage.id, title: `${RUN} private child` });
  check((await spaceOf(opChild.id)) === open.id, "a subpage takes its parent's teamspace");
  check((await spaceOf(prChild.id)) === null, "a subpage of a private page is private");
  check((await levels(opPage.id, owner, bob, guest)) === "full,comment,none", "open teamspace: members outside read and comment");
  check((await levels(opChild.id, bob)) === "comment", "…on its subpages too");
  check((await levels(clPage.id, owner, bob)) === "full,none", "closed teamspace: nothing for members outside it");
  check((await levels(sePage.id, owner, bob)) === "full,none", "private teamspace: nothing for members outside it");
  check((await levels(prPage.id, owner, bob, alice)) === "full,none,none", "private pages: only their creator");
  check((await levels(prChild.id, owner, bob)) === "full,none", "…and their subpages");
  await rejects(
    () => createPage({ userId: bob }, { workspaceId, title: "x", teamspaceId: closed.id }),
    isCode("notMember"),
    "pages are added only to teamspaces one is in",
  );
  await rejects(
    () => createPage({ userId: bob }, { workspaceId, title: "x", teamspaceId: secret.id }),
    isAccessError,
    "a private teamspace one isn't in reads as not found",
  );
  await rejects(
    () => createPage({ userId: guest }, { workspaceId, title: "x", teamspaceId: general }),
    anyError,
    "guests can't add pages to a teamspace",
  );

  // ── Joining and leaving ────────────────────────────────────────────────────────────────────
  await joinTeamspace(bob, open.id);
  check((await levels(opPage.id, bob)) === "full", "joining an open teamspace gives its members' access");
  check((await getTree(bob, workspaceId)).some((n) => n.id === opPage.id && n.section === open.id), "…and puts it in the sidebar");
  await leaveTeamspace(bob, open.id);
  check((await levels(opPage.id, bob)) === "comment", "leaving it goes back to read and comment");
  check(!(await getTree(bob, workspaceId)).some((n) => n.id === opPage.id), "…and takes it out of the sidebar");
  check(disconnected.some((d) => d.teamspaceId === open.id && d.userIds?.includes(bob)), "leaving drops the leaver's open editors");
  await rejects(() => joinTeamspace(bob, closed.id), isCode("notJoinable"), "closed teamspaces can't be joined");
  await rejects(() => joinTeamspace(bob, secret.id), isAccessError, "private teamspaces can't even be found");
  await rejects(() => joinTeamspace(guest, open.id), anyError, "guests can't join teamspaces");
  await rejects(
    () => addTeamspaceMembers(owner, closed.id, [guest]),
    isCode("notMember"),
    "guests can't be added to teamspaces",
  );
  await rejects(() => addTeamspaceMembers(bob, closed.id, [bob]), anyError, "people outside a teamspace can't add to it");
  await addTeamspaceMembers(owner, closed.id, [bob]);
  check((await levels(clPage.id, bob)) === "full", "an owner adding someone to a closed teamspace gives access");
  await rejects(() => leaveTeamspace(owner, closed.id), isCode("lastOwner"), "the last owner can't leave");
  rechecked.length = 0;
  await setTeamspaceRole(owner, closed.id, bob, "owner");
  check(rechecked.length === 0, "becoming a teamspace owner takes nothing away", rechecked);
  await leaveTeamspace(owner, closed.id);
  check((await levels(clPage.id, owner)) === "none", "a workspace owner who left a closed teamspace loses its pages");
  const closedForOwner = (await listTeamspaces(owner, workspaceId)).find((t) => t.id === closed.id)!;
  check(closedForOwner.canManage, "…but still manages it, as a workspace owner");
  await addTeamspaceMembers(owner, closed.id, [owner], "owner");
  rechecked.length = 0;
  await setTeamspaceRole(owner, closed.id, bob, "member");
  check(rechecked.join() === `${workspaceId}:${bob}`, "a teamspace owner made a member has their open editors checked again", rechecked);
  await removeTeamspaceMember(owner, closed.id, bob);
  check((await levels(clPage.id, bob)) === "none", "removing someone takes the access away");
  const byMember = await teamspacesByMember(owner, workspaceId);
  check(
    (byMember.get(bob) ?? []).some((t) => t.id === general) && !(byMember.get(bob) ?? []).some((t) => t.id === closed.id),
    "the members table lists each person's teamspaces",
    Object.fromEntries(byMember),
  );

  // ── Nothing private leaks ──────────────────────────────────────────────────────────────────
  const hidden = [clPage.id, sePage.id, prPage.id, prChild.id];
  const hits = new Set((await searchPages(bob, RUN, { workspaceId, limit: 50 })).map((h) => h.id));
  check(!hidden.some((id) => hits.has(id)), "search leaves out closed, private-teamspace and private pages", [...hits]);
  check(hits.has(opPage.id) && hits.has(genPage.id), "…but finds open and default teamspace pages");
  const mentionable = new Set((await mentionCandidates(bob, genPage.id, RUN)).pages.map((p) => p.id));
  check(!hidden.some((id) => mentionable.has(id)) && mentionable.has(opPage.id), "the @ menu offers only pages bob can see");
  const tree = new Set((await getTree(bob, workspaceId)).map((n) => n.id));
  check(!hidden.some((id) => tree.has(id)) && !tree.has(opPage.id) && tree.has(genPage.id), "bob's sidebar has only his teamspaces' pages");
  // A whole-workspace export is for its owners; even theirs leaves out other people's private pages.
  const alicesSecret = await createPage({ userId: alice }, { workspaceId, title: `${RUN} alice secret`, teamspaceId: alicePriv.id });
  const alicesOwn = await createPage({ userId: alice }, { workspaceId, title: `${RUN} alice own`, teamspaceId: null });
  const exported = new Set((await planExport(owner, { workspaceId })).pages.map((p) => p.id));
  check(
    !exported.has(alicesSecret.id) && !exported.has(alicesOwn.id) && exported.has(genPage.id) && exported.has(prPage.id),
    "a workspace export leaves out private teamspaces and private pages of others, even for an owner",
  );
  await rejects(() => planExport(bob, { workspaceId }), isAccessError, "members can't export the whole workspace");
  check((await levels(alicesOwn.id, owner)) === "none", "a workspace owner can't open a member's private page");
  await rejects(() => planExport(bob, { pageId: prPage.id }), anyError, "exporting someone's private page is refused");
  const tops = new Set((await listChildren(bob, workspaceId, null)).map((c) => c.id));
  check(!hidden.some((id) => tops.has(id)), "top-level listings leave them out");
  const mcpSearch = await callTool(bob, "search", { query: RUN, workspace_id: workspaceId, limit: 50 });
  check(!hidden.some((id) => mcpSearch.text.includes(id)) && mcpSearch.text.includes(opPage.id), "MCP search leaves them out");
  const mcpList = await callTool(bob, "list_pages", { workspace_id: workspaceId });
  check(!hidden.some((id) => mcpList.text.includes(id)), "MCP list_pages leaves them out");
  for (const id of hidden) {
    check((await callTool(bob, "get_page", { page_id: id })).isError, `MCP get_page refuses ${id.slice(RUN.length + 1)}`);
  }
  const mcpSpaces = await callTool(bob, "list_teamspaces", { workspace_id: workspaceId });
  check(
    !mcpSpaces.text.includes(secret.id) && !mcpSpaces.text.includes(alicePriv.id) && mcpSpaces.text.includes(closed.id),
    "MCP list_teamspaces leaves out private teamspaces bob isn't in",
  );
  const mcpOpen = await callTool(bob, "list_pages", { workspace_id: workspaceId, teamspace_id: open.id });
  check(mcpOpen.text.includes(opPage.id), "MCP list_pages lists an open teamspace's pages by teamspace_id");
  const mcpSecret = await callTool(bob, "list_pages", { workspace_id: workspaceId, teamspace_id: secret.id });
  check(!mcpSecret.text.includes(sePage.id), "…but nothing of a private one bob isn't in");
  const sharing = await listPagePermissions(owner, opPage.id);
  check(
    sharing.floors[bob] === "comment" && sharing.floors[owner] === "full" && !(guest in sharing.floors),
    "the share panel knows what 'everyone' gives each member",
    sharing.floors,
  );
  check(sharing.space.kind === "teamspace" && sharing.space.name === open.name, "…and names the teamspace");
  await rejects(() => listPagePermissions(bob, sePage.id), isAccessError, "sharing of a hidden page stays hidden");

  // A page shared by name from a closed teamspace shows under Shared, and only that page.
  await setPagePermission(owner, clPage.id, bob, "view");
  const shared = (await getTree(bob, workspaceId)).find((n) => n.id === clPage.id);
  check(shared?.section === "shared" && shared.level === "view", "a page shared by name shows under Shared", shared);
  check((await levels(sePage.id, bob)) === "none", "sharing one page doesn't open the rest of a teamspace");

  // ── Moving pages ───────────────────────────────────────────────────────────────────────────
  const mv = await createPage({ userId: owner }, { workspaceId, title: `${RUN} mover`, teamspaceId: general });
  const mvChild = await createPage({ userId: owner }, { workspaceId, parentId: mv.id, title: `${RUN} mover child` });
  await movePage(owner, mv.id, null, undefined, closed.id);
  check((await spaceOf(mv.id)) === closed.id && (await spaceOf(mvChild.id)) === closed.id, "moving a page moves its subpages' teamspace too");
  check((await levels(mvChild.id, bob, owner)) === "none,full", "…and they take the new teamspace's access");
  await movePage(owner, mv.id, null, undefined, null);
  check((await spaceOf(mvChild.id)) === null, "moving to private makes the subtree private");
  check((await levels(mv.id, owner, alice)) === "full,none", "…only the mover keeps access");
  await movePage(owner, mv.id, genPage.id);
  check((await spaceOf(mvChild.id)) === general, "moving under a page takes that page's teamspace");
  check((await levels(mvChild.id, bob)) === "full", "…and its access");
  await movePage(owner, mv.id, opPage.id);
  check((await spaceOf(mv.id)) === open.id && (await levels(mv.id, bob)) === "comment", "…in an open teamspace too");
  const bobs = await createPage({ userId: bob }, { workspaceId, title: `${RUN} bob's` });
  await rejects(() => movePage(bob, bobs.id, null, undefined, closed.id), anyError, "moving into a teamspace one isn't in is refused");
  await rejects(() => movePage(bob, bobs.id, null, undefined, secret.id), isAccessError, "…a private one reads as not found");
  await rejects(() => movePage(bob, bobs.id, sePage.id), isAccessError, "…and so does moving under its pages");
  await rejects(() => movePage(bob, opPage.id, null, undefined, general), anyError, "moving a page one only reads is refused");
  check((await spaceOf(bobs.id)) === general, "refused moves leave the page where it was");

  // A restricted page keeps its people but not its "everyone" entry when it changes space.
  const restricted = await createPage({ userId: owner }, { workspaceId, title: `${RUN} restricted`, teamspaceId: general });
  await setPagePermission(owner, restricted.id, owner, "full");
  await setPagePermission(owner, restricted.id, alice, "edit");
  await setPagePermission(owner, restricted.id, null, "none");
  check((await levels(restricted.id, bob, alice)) === "none,edit", "a restricted page is closed to the rest of the workspace");
  await movePage(owner, restricted.id, null, undefined, open.id);
  check((await levels(restricted.id, bob, alice, owner)) === "comment,edit,full", "moved to an open teamspace it takes its access; named people keep theirs");

  // MCP moves follow the same rules.
  const viaMcp = await createPage({ userId: owner }, { workspaceId, title: `${RUN} via mcp`, teamspaceId: general });
  const moved = await callTool(owner, "move_page", { page_id: viaMcp.id, parent_id: null, teamspace_id: "private" }, true);
  check(!moved.isError && (await spaceOf(viaMcp.id)) === null, "MCP move_page to private", moved.text);
  check((await levels(viaMcp.id, bob)) === "none", "…closes it to others");
  const toClosed = await callTool(bob, "move_page", { page_id: bobs.id, parent_id: null, teamspace_id: closed.id }, true);
  check(toClosed.isError && /Join the teamspace/.test(toClosed.text) && (await spaceOf(bobs.id)) === general, "MCP move_page into a teamspace bob isn't in is refused");
  const mcpCreated = await callTool(owner, "create_page", { workspace_id: workspaceId, title: `${RUN} mcp private` }, true);
  check((await spaceOf(mcpCreated.data.id)) === null, "MCP create_page without teamspace_id makes a private page");
  const mcpInTeam = await callTool(owner, "create_page", { teamspace_id: open.id, title: `${RUN} mcp team` }, true);
  check((await spaceOf(mcpInTeam.data.id)) === open.id, "MCP create_page with teamspace_id puts it there", mcpInTeam.text);
  const mcpRefused = await callTool(bob, "create_page", { teamspace_id: secret.id, title: "x" }, true);
  check(mcpRefused.isError && /Unknown teamspace_id/.test(mcpRefused.text), "MCP create_page in a hidden teamspace reads as unknown");

  // The REST API goes through the same operations.
  const bobToken = (await createApiToken(bob, { name: RUN, scopes: ["pages:read", "pages:write"] })).secret;
  const ownerToken = (await createApiToken(owner, { name: RUN, scopes: ["pages:read", "pages:write"] })).secret;
  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await handleApiRequest(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    return { status: res.status, text, data: text ? JSON.parse(text) : null };
  };
  const restSpaces = await api(bobToken, "GET", `/workspaces/${workspaceId}/teamspaces`);
  check(
    restSpaces.status === 200 && restSpaces.text.includes(closed.id) && !restSpaces.text.includes(secret.id) && !restSpaces.text.includes(alicePriv.id),
    "REST lists the teamspaces bob can see, private ones left out",
    restSpaces,
  );
  // The closed teamspace's page was shared with bob by name above; the rest stays hidden.
  const stillHidden = [sePage.id, prPage.id, prChild.id];
  const restSearch = await api(bobToken, "GET", `/search?query=${encodeURIComponent(RUN)}&workspace_id=${workspaceId}&limit=50`);
  check(
    restSearch.status === 200 && !stillHidden.some((id) => restSearch.text.includes(id)) && restSearch.text.includes(clPage.id),
    "REST search leaves hidden pages out and finds the one shared by name",
    restSearch.status,
  );
  const restSecretList = await api(bobToken, "GET", `/workspaces/${workspaceId}/pages?teamspace_id=${secret.id}`);
  check(!restSecretList.text.includes(sePage.id), "REST page lists leave a hidden teamspace's pages out");
  check((await api(bobToken, "GET", `/pages/${prPage.id}`)).status === 404, "REST reading someone's private page is not found");
  const restPrivate = await api(ownerToken, "POST", "/pages", { workspace_id: workspaceId, title: `${RUN} rest private` });
  check(restPrivate.status === 201 && (await spaceOf(restPrivate.data.id)) === null, "REST creates top-level pages private by default", restPrivate);
  const restTeam = await api(ownerToken, "POST", "/pages", { workspace_id: workspaceId, title: `${RUN} rest team`, teamspace_id: open.id });
  check(restTeam.status === 201 && (await spaceOf(restTeam.data.id)) === open.id && restTeam.data.teamspace === open.name, "…or in the teamspace named", restTeam);
  const restMove = await api(bobToken, "POST", `/pages/${bobs.id}/move`, { parent_id: null, teamspace_id: closed.id });
  check(restMove.status === 403 && (await spaceOf(bobs.id)) === general, "REST won't move a page into a teamspace bob isn't in", restMove);
  const restMoveOk = await api(ownerToken, "POST", `/pages/${restPrivate.data.id}/move`, { parent_id: null, teamspace_id: general });
  check(restMoveOk.status === 200 && (await spaceOf(restPrivate.data.id)) === general, "REST moves a page into a teamspace", restMoveOk);

  // Duplicates stay in their teamspace.
  const copy = await duplicatePage({ userId: owner }, clPage.id, " (copy)");
  check((await spaceOf(copy.id)) === closed.id, "a duplicate stays in its teamspace");

  // ── Restoring a page whose parent is gone keeps its access ─────────────────────────────────
  const top = await createPage({ userId: owner }, { workspaceId, title: `${RUN} top`, teamspaceId: general });
  const under = await createPage({ userId: owner }, { workspaceId, parentId: top.id, title: `${RUN} under` });
  await setPagePermission(owner, top.id, owner, "full");
  await setPagePermission(owner, top.id, null, "none");
  await archivePage(owner, top.id);
  await restorePage(owner, under.id);
  const [lifted] = await db.select({ parentId: page.parentId }).from(page).where(eq(page.id, under.id));
  check(lifted.parentId === null, "restoring a page from a trashed parent lifts it to the top");
  check((await levels(under.id, bob, owner)) === "none,full", "…keeping the access it had instead of opening up");

  // ── Changing access ────────────────────────────────────────────────────────────────────────
  await rejects(
    () => updateTeamspace(alice, alicePriv.id, { access: "default" }),
    isCode("ownersOnly"),
    "a teamspace owner who isn't a workspace owner can't make it default",
  );
  await rejects(() => updateTeamspace(bob, open.id, { name: "mine" }), anyError, "people who don't manage a teamspace can't change it");
  const aliceOpen = await createTeamspace(alice, workspaceId, { name: `${RUN} Alice open`, access: "open" });
  const aoPage = await createPage({ userId: alice }, { workspaceId, title: `${RUN} alice open page`, teamspaceId: aliceOpen.id });
  await updateTeamspace(owner, aliceOpen.id, { access: "default" });
  check((await levels(aoPage.id, bob, dave)) === "full,full", "making a teamspace default puts everyone in it");
  await updateTeamspace(owner, aliceOpen.id, { access: "closed" });
  const kept = await rowsOf(aliceOpen.id);
  check(kept.has(bob) && kept.has(dave) && kept.get(alice) === "owner" && !kept.has(guest), "…and when it stops being default everyone stays in it", Object.fromEntries(kept));
  await leaveTeamspace(bob, aliceOpen.id);
  check((await levels(aoPage.id, bob)) === "none", "…free to leave it");
  disconnected.length = 0;
  await updateTeamspace(owner, open.id, { access: "closed" });
  check((await levels(opPage.id, carol)) === "none", "closing an open teamspace shuts out those who hadn't joined");
  check(disconnected.some((d) => d.teamspaceId === open.id && !d.userIds), "…and drops open editors of its pages");
  await updateTeamspace(owner, open.id, { access: "open" });

  // ── Archiving ──────────────────────────────────────────────────────────────────────────────
  await setTeamspaceArchived(owner, closed.id, true);
  check(!(await sidebarTeamspaces(owner, workspaceId)).some((t) => t.id === closed.id), "an archived teamspace leaves the sidebar");
  check(!(await listTeamspaces(owner, workspaceId, { archived: "active" })).some((t) => t.id === closed.id), "…and the active list");
  await rejects(
    () => createPage({ userId: owner }, { workspaceId, title: "x", teamspaceId: closed.id }),
    isCode("archived"),
    "…and takes no new pages",
  );
  check((await levels(clPage.id, owner)) === "full", "…while its pages keep their access");
  await setTeamspaceArchived(owner, closed.id, false);
  check((await sidebarTeamspaces(owner, workspaceId)).some((t) => t.id === closed.id), "restoring brings it back");

  // ── Sidebar ────────────────────────────────────────────────────────────────────────────────
  const sidebar = await getSidebar(owner, workspaceId);
  const node = (id: string) => sidebar.tree.find((n) => n.id === id);
  check(node(genPage.id)?.section === general && node(opPage.id)?.section === open.id, "the sidebar groups pages by teamspace");
  check(node(prPage.id)?.section === "private" && node(prChild.id)?.parentId === prPage.id, "…and private pages under Private");
  check(sidebar.teamspaces.every((t) => t.joined), "…with a section for each teamspace one is in");

  // ── Pages created behind the app's back still land somewhere ──────────────────────────────
  const raw = `${RUN}-raw`;
  await db.insert(page).values({ id: raw, workspaceId, title: "raw", position: 99 });
  check((await spaceOf(raw)) === general, "a top-level page inserted without a teamspace goes to the default teamspace");
  const rawCopy = `${RUN}-raw-copy`;
  await db.transaction(async (tx) => {
    await tx.insert(page).values({ id: rawCopy, workspaceId, title: "raw copy", position: 100 });
    await tx.insert(pagePermission).values({ pageId: rawCopy, workspaceId, userId: guest, level: "view" });
  });
  check(
    (await spaceOf(rawCopy)) === general && (await levels(rawCopy, owner, guest)) === "full,view",
    "…also when it carries named entries only (a copy made by older code), keeping the access it had before",
  );
  const rawPrivate = `${RUN}-raw-private`;
  await db.transaction(async (tx) => {
    await tx.insert(page).values({ id: rawPrivate, workspaceId, title: "raw private", position: 101 });
    await tx.insert(pagePermission).values([
      { pageId: rawPrivate, workspaceId, userId: null, level: "none" },
      { pageId: rawPrivate, workspaceId, userId: owner, level: "full" },
    ]);
  });
  check((await spaceOf(rawPrivate)) === null, "…but one given an 'everyone' entry in the same transaction stays private");
  await rejects(
    () => db.update(page).set({ teamspaceId: `${RUN}-nope` }).where(eq(page.id, raw)),
    anyError,
    "a page can't point at a teamspace that doesn't exist",
  );
  const otherWs = `${RUN}-ws2`;
  await db.insert(workspace).values({ id: otherWs, name: `${RUN} other` });
  const [otherGeneral] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, otherWs));
  await rejects(
    () => db.update(page).set({ teamspaceId: otherGeneral.id }).where(eq(page.id, raw)),
    anyError,
    "…nor at another workspace's teamspace",
  );

  // ── Leaving the workspace ─────────────────────────────────────────────────────────────────
  const carols = await createTeamspace(carol, workspaceId, { name: `${RUN} Carol`, access: "closed" });
  await addTeamspaceMembers(carol, carols.id, [dave]);
  const carolsSolo = await createTeamspace(carol, workspaceId, { name: `${RUN} Carol solo`, access: "private" });
  await removeMember(owner, workspaceId, carol);
  check(!(await rowsOf(carols.id)).has(carol), "someone leaving the workspace leaves its teamspaces");
  check((await rowsOf(carols.id)).get(dave) === "owner", "…a teamspace they owned passes to its oldest member");
  check((await rowsOf(carolsSolo.id)).get(owner) === "owner", "…or to the owner who removed them when nobody is left");
  await addTeamspaceMembers(owner, open.id, [bob]);
  await setMemberRole(owner, workspaceId, bob, "guest");
  check(!(await rowsOf(open.id)).has(bob), "someone made guest leaves every teamspace");
  check((await levels(genPage.id, bob)) === "none", "…and default teamspace pages close to them");
  check((await levels(clPage.id, bob)) === "view", "…but pages shared with them by name stay shared");

  const count = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), sql`${page.parentId} is null and ${page.teamspaceId} is not null`));
  check(count[0].n > 0, "sanity: top-level teamspace pages exist");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, `${RUN}-ws2`]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

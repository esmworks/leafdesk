/**
 * End-to-end check of the membership admin role against the database: a membership admin invites
 * people (as anything but owner), sees and withdraws invitations (never an owner's), changes roles
 * among membership admin, member and guest, removes anyone but owners (and doesn't take over their
 * pages), decides join requests (and hears about them), and runs groups without putting themselves
 * in one. Everything else owners decide stays refused: workspace settings, the join link, ownership,
 * SCIM, SSO, legal holds, the audit log, analytics, AI usage, connections, approved networks,
 * connected apps, exports, audit-log API tokens. On content they get exactly what a member gets:
 * every page's access level and the pages listed match a member's in the same place, "SSO only"
 * holds them like members, and agents count them as members. MCP's list_users, list_workspaces and
 * invite_member and the REST API's workspace list name the role. Creates its own users and
 * workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/membership-admin-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No server needed.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, notification, page, user, workspace, workspaceInvitation, workspaceJoinRequest, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { AccessError, pageAccessOf, pageVisibleTo, policyHold } = await import("@/server/access");
const { registerCollab } = await import("@/server/collab/bridge");
const { resolveAgentLevel } = await import("@/lib/agent-sharing");
const { visibleSettingsTabs } = await import("@/lib/settings-tabs");
const { createPage } = await import("@/server/pages");
const { setPagePermission, setPageGroupPermission } = await import("@/server/permissions");
const { createTeamspace } = await import("@/server/teamspaces");
const { addGroupMembers, changeGroup, createGroup, deleteGroup, GroupError, removeGroupMember, renameGroup } = await import("@/server/groups");
const { approveJoinRequest, declineJoinRequest, listJoinRequests, requestToJoinFrom, setJoinRequestMailer } = await import("@/server/join-requests");
const { setShareMailer } = await import("@/server/share-emails");
const { listInbox } = await import("@/server/notifications");
const { listGuests } = await import("@/server/guests");
const { listScimTokens, createScimToken } = await import("@/server/scim");
const { listLegalHolds } = await import("@/server/legal-hold");
const { listAuditEvents } = await import("@/server/audit");
const { workspaceAnalytics } = await import("@/server/analytics");
const { workspaceAiUsage } = await import("@/server/ai-usage");
const { listConnections } = await import("@/server/connections/manage");
const { getAllowedNetworks } = await import("@/server/allowed-networks");
const { listWorkspaceApps } = await import("@/server/workspace-apps");
const { getSsoConnection } = await import("@/server/sso");
const { planExport } = await import("@/server/export");
const { createApiToken, ApiTokenError } = await import("@/server/api/tokens");
const ops = await import("@/server/operations");
const {
  addMembers,
  canInviteGuests,
  countMembersWithoutTwoFactor,
  domainPeople,
  getJoinLink,
  listInvitations,
  memberInviteAccess,
  removeMember,
  renameWorkspace,
  revokeInvitation,
  setJoinLink,
  setMemberRole,
  transferOwnership,
  updateWorkspaceSettings,
} = await import("@/server/workspaces");

const RUN = `madmin-e2e-${Date.now().toString(36)}`;

// Removing someone closes their open editors through the collab service, which only runs inside
// the app server; nothing is open here.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectUser() {},
  async disconnectLostAccess() {},
  async disconnectHeldBack() {},
  async disconnectTeamspace() {},
} as unknown as Parameters<typeof registerCollab>[0]);
setJoinRequestMailer(async () => {});
setShareMailer(async () => {});

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

const isAccessError = (error: unknown) => error instanceof AccessError;
const groupCode = (code: string) => (error: unknown) => error instanceof GroupError && error.code === code;

const ids = {
  owner: `${RUN}-owner`,
  owner2: `${RUN}-owner2`,
  admin: `${RUN}-admin`,
  member: `${RUN}-member`,
  twin: `${RUN}-twin`,
  guest: `${RUN}-guest`,
  target: `${RUN}-target`,
  leaver: `${RUN}-leaver`,
  joiner: `${RUN}-joiner`,
  decliner: `${RUN}-decliner`,
  existing: `${RUN}-existing`,
};
const email = (id: string) => `${id}@example.test`;
const workspaceId = `${RUN}-ws`;

const roleOf = async (userId: string) =>
  (
    await db
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
  )[0]?.role ?? null;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "membership-admin-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: email(id), emailVerified: true })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.owner2, role: "owner" },
    { workspaceId, userId: ids.admin, role: "membership_admin" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.twin, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.target, role: "member" },
    { workspaceId, userId: ids.leaver, role: "member" },
  ]);

  // ------------------------------------------------------------------ the database knows the role
  await rejects(
    () => db.update(workspaceMember).set({ role: "admin" as never }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.twin))),
    (error) => /workspace_member_role_check/.test(String((error as { cause?: unknown }).cause ?? error)),
    "the database refuses a role it doesn't know",
  );

  // ------------------------------------------------------------------ settings tabs
  const adminTabs = visibleSettingsTabs({ guest: false, managesGuests: await canInviteGuests(ids.admin, workspaceId), owner: false });
  const memberTabs = visibleSettingsTabs({ guest: false, managesGuests: await canInviteGuests(ids.member, workspaceId), owner: false });
  check(["members", "guests", "groups"].every((tab) => adminTabs.includes(tab as never)), "a membership admin gets the Members, Guests and Groups tabs", adminTabs);
  check(
    ["connections", "webhooks", "storage", "analytics", "aiUsage", "audit"].every((tab) => !adminTabs.includes(tab as never)),
    "…and none of the owners' tabs",
    adminTabs,
  );
  check(!memberTabs.includes("guests"), "a member doesn't get the Guests tab by default", memberTabs);

  // ------------------------------------------------------------------ inviting
  check((await memberInviteAccess(ids.admin, workspaceId)) === "direct", "a membership admin adds people right away while only owners may");
  check((await memberInviteAccess(ids.member, workspaceId)) === null, "…where a member can't");
  const invited = await addMembers(ids.admin, workspaceId, [`new-m@${RUN}.test`, `new-ma@${RUN}.test`], "member");
  check(invited.every((r) => r.kind === "invited"), "a membership admin invites members", invited);
  const asAdmin = await addMembers(ids.admin, workspaceId, [`new-a@${RUN}.test`], "membership_admin");
  check(asAdmin[0]?.kind === "invited", "…and other membership admins", asAdmin);
  const asGuest = await addMembers(ids.admin, workspaceId, [`new-g@${RUN}.test`], "guest");
  check(asGuest[0]?.kind === "invited", "…and guests", asGuest);
  await rejects(() => addMembers(ids.admin, workspaceId, [`new-o@${RUN}.test`], "owner"), isAccessError, "…but never owners");
  const added = await addMembers(ids.admin, workspaceId, [email(ids.existing)], "membership_admin");
  check(added[0]?.kind === "added" && (await roleOf(ids.existing)) === "membership_admin", "an account with a verified address joins as a membership admin", added);
  await rejects(() => addMembers(ids.member, workspaceId, [`new-x@${RUN}.test`], "member"), isAccessError, "a member still can't add anyone while only owners may");
  check(await canInviteGuests(ids.admin, workspaceId), "a membership admin brings guests in by sharing pages");

  // ------------------------------------------------------------------ invitations
  await addMembers(ids.owner, workspaceId, [`future-owner@${RUN}.test`], "owner");
  const ownerSees = await listInvitations(ids.owner, workspaceId);
  const adminSees = await listInvitations(ids.admin, workspaceId);
  check(ownerSees.some((i) => i.role === "owner"), "owners see an invitation to become an owner", ownerSees);
  check(!adminSees.some((i) => i.role === "owner"), "…a membership admin doesn't, nor its link", adminSees);
  check(adminSees.some((i) => i.email === `new-a@${RUN}.test` && i.role === "membership_admin"), "…but sees the others, with their roles", adminSees);
  const ownerInvite = ownerSees.find((i) => i.role === "owner")!;
  await revokeInvitation(ids.admin, workspaceId, ownerInvite.id);
  check((await listInvitations(ids.owner, workspaceId)).some((i) => i.id === ownerInvite.id), "a membership admin can't withdraw an invitation to become an owner");
  const memberInvite = adminSees.find((i) => i.email === `new-m@${RUN}.test`)!;
  await revokeInvitation(ids.admin, workspaceId, memberInvite.id);
  check(!(await listInvitations(ids.admin, workspaceId)).some((i) => i.id === memberInvite.id), "…and withdraws a member's");
  await rejects(() => listInvitations(ids.member, workspaceId), isAccessError, "members don't see invitations");
  const guests = await listGuests(ids.admin, workspaceId);
  check(guests.some((g) => g.email === `new-g@${RUN}.test` && g.invitationId !== null), "the Guests tab lets a membership admin withdraw a guest's invitation", guests);

  // ------------------------------------------------------------------ roles
  await setMemberRole(ids.admin, workspaceId, ids.target, "guest");
  check((await roleOf(ids.target)) === "guest", "a membership admin makes a member a guest");
  await setMemberRole(ids.admin, workspaceId, ids.target, "membership_admin");
  check((await roleOf(ids.target)) === "membership_admin", "…a guest a membership admin");
  await setMemberRole(ids.admin, workspaceId, ids.target, "member");
  check((await roleOf(ids.target)) === "member", "…and a membership admin a member");
  await rejects(() => setMemberRole(ids.admin, workspaceId, ids.target, "owner"), isAccessError, "…but nobody an owner");
  check((await roleOf(ids.target)) === "member", "…which changes nothing");
  await rejects(() => setMemberRole(ids.admin, workspaceId, ids.owner2, "member"), isAccessError, "a membership admin can't demote an owner");
  await rejects(() => setMemberRole(ids.admin, workspaceId, ids.admin, "owner"), isAccessError, "…nor make themselves an owner");
  check((await roleOf(ids.owner2)) === "owner" && (await roleOf(ids.admin)) === "membership_admin", "…roles stay");
  await rejects(() => setMemberRole(ids.member, workspaceId, ids.twin, "guest"), isAccessError, "members don't change roles");
  const [changed] = await db
    .select({ actorId: auditEvent.actorUserId, details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "member.role_changed"), eq(auditEvent.targetId, ids.target)))
    .orderBy(sql`${auditEvent.createdAt} desc`)
    .limit(1);
  check(
    changed?.actorId === ids.admin && (changed.details as { from?: string; to?: string }).from === "membership_admin",
    "the audit log records a membership admin's role change, from and to",
    changed,
  );
  // An owner gives the role too, and takes it away.
  await setMemberRole(ids.owner, workspaceId, ids.twin, "membership_admin");
  await setMemberRole(ids.owner, workspaceId, ids.twin, "member");
  check((await roleOf(ids.twin)) === "member", "owners give and take the role");

  // ------------------------------------------------------------------ removing
  const leaversPage = await createPage({ userId: ids.leaver }, { workspaceId, teamspaceId: null, title: `${RUN} leaver's own` });
  check((await pageAccessOf(ids.admin, leaversPage.id)).level === "none", "a member's private page is theirs alone");
  await removeMember(ids.admin, workspaceId, ids.leaver);
  check((await roleOf(ids.leaver)) === null, "a membership admin removes a member");
  check((await pageAccessOf(ids.admin, leaversPage.id)).level === "none", "…without taking over the pages only they managed");
  check((await pageAccessOf(ids.owner, leaversPage.id)).level === "full", "…which go to the longest-standing owner");
  await rejects(() => removeMember(ids.admin, workspaceId, ids.owner2), isAccessError, "a membership admin can't remove an owner");
  check((await roleOf(ids.owner2)) === "owner", "…who stays");
  await rejects(() => removeMember(ids.member, workspaceId, ids.twin), isAccessError, "members don't remove anyone");
  await removeMember(ids.admin, workspaceId, ids.guest);
  check((await roleOf(ids.guest)) === null, "a membership admin removes a guest");

  // ------------------------------------------------------------------ join requests
  const status = await requestToJoinFrom(workspaceId, ids.joiner, email(ids.joiner), "switcher");
  check(status === "requested", "someone asks to join", status);
  await requestToJoinFrom(workspaceId, ids.decliner, email(ids.decliner), "switcher");
  const told = await db
    .select({ userId: notification.userId })
    .from(notification)
    .where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "join_request")));
  check(told.some((n) => n.userId === ids.admin) && told.some((n) => n.userId === ids.owner), "owners and membership admins hear about it", told);
  check(!told.some((n) => n.userId === ids.member), "…members don't");
  const inbox = await listInbox(ids.admin, workspaceId);
  check(inbox.some((n) => n.kind === "join_request"), "…and it shows in a membership admin's inbox", inbox.map((n) => n.kind));
  const requests = await listJoinRequests(ids.admin, workspaceId);
  check(requests.length === 2, "a membership admin lists the requests", requests);
  await approveJoinRequest(ids.admin, workspaceId, requests.find((r) => r.email === email(ids.joiner))!.id);
  check((await roleOf(ids.joiner)) === "member", "…approves one");
  await declineJoinRequest(ids.admin, workspaceId, requests.find((r) => r.email === email(ids.decliner))!.id);
  check((await roleOf(ids.decliner)) === null, "…and declines another");
  await rejects(() => listJoinRequests(ids.member, workspaceId), isAccessError, "members don't see join requests");
  // No member files a request to bring in an owner today; one that somehow exists is for owners.
  const [ownerAsk] = await db
    .insert(workspaceJoinRequest)
    .values({ workspaceId, kind: "invite", email: `asked-owner@${RUN}.test`, role: "owner", requestedBy: ids.member, source: "member" })
    .returning({ id: workspaceJoinRequest.id });
  await rejects(() => approveJoinRequest(ids.admin, workspaceId, ownerAsk.id), isAccessError, "a membership admin can't approve a request to bring in an owner");
  check((await listJoinRequests(ids.owner, workspaceId)).some((r) => r.id === ownerAsk.id), "…which still waits for an owner");

  // ------------------------------------------------------------------ groups
  const group = await createGroup(ids.admin, workspaceId, `${RUN} Team`, [ids.member]);
  check(Boolean(group.id), "a membership admin creates a group");
  await addGroupMembers(ids.admin, group.id, [ids.target]);
  await renameGroup(ids.admin, group.id, `${RUN} Renamed`);
  await removeGroupMember(ids.admin, group.id, ids.target);
  check(true, "…adds, renames and takes people out");
  await rejects(() => createGroup(ids.admin, workspaceId, `${RUN} Mine`, [ids.admin]), groupCode("ownMembership"), "…but doesn't create one with themselves in it");
  await rejects(() => changeGroup(ids.admin, group.id, { add: [ids.admin] }), groupCode("ownMembership"), "…nor joins one");
  await rejects(() => createGroup(ids.member, workspaceId, `${RUN} Nope`), isAccessError, "members don't create groups");
  await rejects(() => renameGroup(ids.member, group.id, "Nope"), isAccessError, "…nor change them");
  const deletable = await createGroup(ids.admin, workspaceId, `${RUN} Gone`);
  await deleteGroup(ids.admin, deletable.id);
  check(true, "a membership admin deletes a group");

  // ------------------------------------------------------------------ what stays with owners
  const refusals: [string, () => Promise<unknown>][] = [
    ["change workspace settings", () => updateWorkspaceSettings(ids.admin, workspaceId, { memberInvites: "any_member" })],
    ["rename the workspace", () => renameWorkspace(ids.admin, workspaceId, "Renamed")],
    ["see the join link", () => getJoinLink(ids.admin, workspaceId)],
    ["turn the join link on", () => setJoinLink(ids.admin, workspaceId, "enable")],
    ["hand over ownership", () => transferOwnership(ids.admin, workspaceId, ids.member)],
    ["list SCIM tokens", () => listScimTokens(ids.admin, workspaceId)],
    ["create a SCIM token", () => createScimToken(ids.admin, workspaceId, "x")],
    ["see the SSO connection", () => getSsoConnection(ids.admin, workspaceId)],
    ["list legal holds", () => listLegalHolds(ids.admin, workspaceId)],
    ["read the audit log", () => listAuditEvents(ids.admin, workspaceId, { page: 1 } as never)],
    ["read analytics", () => workspaceAnalytics(ids.admin, workspaceId, 30 as never)],
    ["read AI usage", () => workspaceAiUsage(ids.admin, workspaceId)],
    ["list connections", () => listConnections(ids.admin, workspaceId)],
    ["see approved networks", () => getAllowedNetworks(ids.admin, workspaceId)],
    ["list connected apps", () => listWorkspaceApps(ids.admin, workspaceId)],
    ["see people on verified domains", () => domainPeople(ids.admin, workspaceId)],
    ["count members without two-step", () => countMembersWithoutTwoFactor(ids.admin, workspaceId)],
    ["export the whole workspace", () => planExport(ids.admin, { workspaceId })],
  ];
  for (const [what, fn] of refusals) await rejects(fn, isAccessError, `a membership admin can't ${what}`);
  await rejects(
    () => createApiToken(ids.admin, { name: "audit", scopes: ["audit:read"], workspaceId }),
    (error) => error instanceof ApiTokenError,
    "a membership admin can't make an API token that reads the audit log",
  );

  // ------------------------------------------------------------------ content: exactly a member's
  // The twin is a member in every place the membership admin is.
  await db.update(workspaceMember).set({ role: "membership_admin" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.existing)));
  const defaultTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Everyone`, access: "default" });
  const openTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Open`, access: "open" });
  const closedTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Closed`, access: "closed" });
  const privateTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Private`, access: "private" });
  const inDefault = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: defaultTs.id, title: "Default" });
  const inOpen = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: openTs.id, title: "Open" });
  const inClosed = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: closedTs.id, title: "Closed" });
  const inPrivate = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: privateTs.id, title: "Private" });
  const ownersOwn = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: null, title: "Owner's own" });
  const restricted = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: defaultTs.id, title: "Restricted" });
  await setPagePermission(ids.owner, restricted.id, ids.owner, "full");
  await setPagePermission(ids.owner, restricted.id, null, "view");
  const nested = await createPage({ userId: ids.owner }, { workspaceId, parentId: restricted.id, title: "Nested" });
  const grouped = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: defaultTs.id, title: "Grouped" });
  await setPagePermission(ids.owner, grouped.id, ids.owner, "full");
  await setPagePermission(ids.owner, grouped.id, null, "none");
  const pair = await createGroup(ids.owner, workspaceId, `${RUN} Pair`, [ids.admin, ids.twin]);
  await setPageGroupPermission(ids.owner, grouped.id, pair.id, "comment");
  const pages = { inDefault, inOpen, inClosed, inPrivate, ownersOwn, restricted, nested, grouped };
  for (const [name, p] of Object.entries(pages)) {
    const [admin, twin] = await Promise.all([pageAccessOf(ids.admin, p.id), pageAccessOf(ids.twin, p.id)]);
    check(admin.level === twin.level, `a membership admin's access to "${name}" is a member's (${twin.level})`, { admin: admin.level, twin: twin.level });
  }
  check((await pageAccessOf(ids.admin, inDefault.id)).level === "full", "…full where members get full");
  check((await pageAccessOf(ids.admin, grouped.id)).level === "comment", "…and a group's level where the page gives one");
  const visible = async (userId: string) =>
    (await db.select({ id: page.id }).from(page).where(and(eq(page.workspaceId, workspaceId), pageVisibleTo(userId)))).map((r) => r.id).sort();
  check(JSON.stringify(await visible(ids.admin)) === JSON.stringify(await visible(ids.twin)), "…and the pages they can see are a member's");

  const ssoOnly = {
    requireTwoFactor: false,
    loginMethod: "sso" as const,
    hasConnection: true,
    instanceSso: false,
    allowedNetworks: [],
  };
  const facts = { strong: true, ssoProviderId: null, ip: "127.0.0.1" };
  check(policyHold({ ...ssoOnly, role: "membership_admin" }, facts, workspaceId) === "sso", "\"SSO only\" holds a membership admin back like a member");
  check(policyHold({ ...ssoOnly, role: "owner" }, facts, workspaceId) === null, "…while owners keep their other ways in");
  check(
    resolveAgentLevel({ role: "membership_admin", everyone: "interact" }) === resolveAgentLevel({ role: "member", everyone: "interact" }),
    "agents shared with everyone reach a membership admin as they reach members",
  );

  // ------------------------------------------------------------------ MCP and REST
  const users = await callTool(ids.admin, "list_users", { workspace_id: workspaceId });
  check(
    !users.isError && users.data.users.some((u: { id: string; role: string }) => u.id === ids.admin && u.role === "membership_admin"),
    "MCP list_users names the role",
    users.text,
  );
  const mine = await callTool(ids.admin, "list_workspaces", {});
  check(
    !mine.isError && mine.data.workspaces.some((w: { id: string; role: string }) => w.id === workspaceId && w.role === "membership_admin"),
    "MCP list_workspaces names it",
    mine.text,
  );
  const rest = await ops.listWorkspaces({ userId: ids.admin } as never);
  check(rest.workspaces.some((w) => w.id === workspaceId && w.role === "membership_admin"), "…and so does the REST API's workspace list", rest);
  const mcpInvite = await callTool(ids.admin, "invite_member", { workspace_id: workspaceId, email: `mcp-ma@${RUN}.test`, role: "membership_admin" });
  check(!mcpInvite.isError && mcpInvite.data.status === "invited" && mcpInvite.data.role === "membership_admin", "MCP invite_member invites a membership admin", mcpInvite.text);
  const mcpOwner = await callTool(ids.admin, "invite_member", { workspace_id: workspaceId, email: `mcp-o@${RUN}.test`, role: "owner" });
  check(mcpOwner.isError, "…but a membership admin can't invite an owner through it", mcpOwner.text);
  const mcpMember = await callTool(ids.member, "invite_member", { workspace_id: workspaceId, email: `mcp-m@${RUN}.test`, role: "member" });
  check(mcpMember.isError, "…nor a member while only owners may add people", mcpMember.text);
  const stored = await db
    .select({ role: workspaceInvitation.role })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, `mcp-ma@${RUN}.test`)));
  check(stored[0]?.role === "membership_admin", "…the invitation holds the role");

  console.log(`\n${passed} checks passed`);
} finally {
  setJoinRequestMailer(null);
  setShareMailer(null);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await db.$client.end();
}

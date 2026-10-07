/**
 * End-to-end check of the workspace audit log against the database: every family of recorded
 * changes (members and roles, invitations, the join link and join requests, page sharing and
 * access requests, teamspaces, groups, settings with before and after, single sign-on and SCIM,
 * permanent deletes by people and by the retention cleanup, publishing and the site, API tokens
 * and connected apps, exports), each with the right kind of actor: a person, an MCP client and an
 * API token acting for one, the identity provider through a SCIM request, and the server itself.
 * Also that a recording that fails leaves the change in place (inside a transaction and after
 * one), that only owners list and download the log, its filters and paging, and that the daily
 * cleanup prunes events older than a year in the workspaces it runs on only.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/audit-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { isDeepStrictEqual } from "node:util";


try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, oauthClient, oauthConsent, page, pagePublication, user, workspace, workspaceInvitation, workspaceMember, workspaceSite } =
  await import("@/db/schema");
const { createTranslator } = await import("next-intl");
const { default: en } = await import("@/i18n/messages/en");
const { AUDIT_ACTOR_KINDS, AUDIT_PAGE_SIZE, auditActorName, auditCsvRows, parseAuditFilters, describeAuditEvent } = await import("@/lib/audit");

type AuditEvent = import("@/lib/audit").AuditEvent;
type AuditTranslator = import("@/lib/audit").AuditTranslator;
type AuditFilters = import("@/lib/audit").AuditFilters;
const { toCsv } = await import("@/lib/csv");
const { CLIENT_IP_HEADER } = await import("@/lib/client-ip");
const { env } = await import("@/lib/env");
const { domainRecordName } = await import("@/lib/sso-config");
const { AccessError } = await import("@/server/access");
const { approveAccessRequest, declineAccessRequest, listAccessRequests, requestPageAccess } = await import("@/server/access-requests");
const { auditActors, auditEventsForExport, failAuditWritesForTesting, listAuditEvents, recordAudit } = await import("@/server/audit");
const { createAgent } = await import("@/server/agents/manage");
const { createApiToken, revokeApiToken } = await import("@/server/api/tokens");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { runAsConnectedApp } = await import("@/server/connected-app");
const { archiveResponse, databaseCsv, ENGLISH_EXPORT_LABELS, planExport, startExport } = await import("@/server/export");
const { changeGroup, createGroup, deleteGroup } = await import("@/server/groups");
const { approveJoinRequest, declineJoinRequest, listJoinRequests, requestInvitation, requestToJoinFrom, setJoinRequestMailer } =
  await import("@/server/join-requests");
const { revokeConnectedApp } = await import("@/server/mcp/grants");
const { archivePage, createPage, deletePagePermanently } = await import("@/server/pages");
const {
  removePageGroupPermission,
  removePageInvitation,
  removePagePermission,
  setPageGroupPermission,
  setPagePermission,
  sharePageByEmail,
} = await import("@/server/permissions");
const { printDocument } = await import("@/server/print");
const { publishPage, revokePublication, unpublishPage } = await import("@/server/publication");
const { pruneAuditEvents, runRetention } = await import("@/server/retention");
const { createScimToken, handleScimRequest, revokeScimToken } = await import("@/server/scim");
const { setShareMailer } = await import("@/server/share-emails");
const { removeSite, saveSite } = await import("@/server/site");
const { removeSsoConnection, saveSsoConnection, verifySsoDomains } = await import("@/server/sso");
const {
  addTeamspaceGroups,
  addTeamspaceMembers,
  createTeamspace,
  removeTeamspaceGroup,
  removeTeamspaceMember,
  setTeamspaceArchived,
  setTeamspaceRole,
  updateTeamspace,
} = await import("@/server/teamspaces");
const {
  addMember,
  addMembers,
  acceptInvitation,
  joinWithLink,
  removeMember,
  renameWorkspace,
  revokeInvitation,
  setJoinLink,
  setMemberRole,
  transferOwnership,
  updateWorkspaceSettings,
  withdrawFromWorkspaces,
} = await import("@/server/workspaces");

const RUN = `audit-e2e-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;
const DOMAIN = `${RUN}.test`;

// Page changes notify open editors through the collab service; the real one (without a
// websocket server) also reads documents for the exports.
const { hocuspocus, service } = createCollab();
registerCollab(service);
// Emails are dropped instead of sent.
setShareMailer(async () => {});
setJoinRequestMailer(async () => {});

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

const isAccess = (e: unknown) => e instanceof AccessError;

const ids = {
  owner: `${RUN}-owner`,
  bob: `${RUN}-bob`,
  gus: `${RUN}-guest`,
  nora: `${RUN}-nora`,
  carl: `${RUN}-carl`,
  sam: `${RUN}-sam`,
  olly: `${RUN}-outsider`,
  lina: `${RUN}-lina`,
};
// Signs up once invited, below.
const accepter = `${RUN}-accepter`;
// Deletes their account (the workspace part of it), below.
const leaver = `${RUN}-leaver`;
const userIds = [...Object.values(ids), accepter, leaver];
/** Agents' users made below: deleting the workspaces leaves them to delete too. */
const agentUsers: string[] = [];
const names: Record<string, string> = {
  [ids.owner]: "Olivia Owner",
  [ids.bob]: "Bora Member",
  [ids.gus]: "Gül Guest",
  [ids.nora]: "Nora New",
  [ids.carl]: "Cem Connected",
  [ids.sam]: "Sam Provisioned",
  [ids.olly]: "Oya Outsider",
  [ids.lina]: "Lina Link",
  [accepter]: "Ali Accepter",
};
const email = (id: string) => `${id}@example.test`;
// Main: everything happens here. Other: ownership handed over and someone leaving. Log: synthetic
// events for filters and paging. Outside: never named in a retention run.
const ws = { main: `${RUN}-main`, other: `${RUN}-other`, log: `${RUN}-log`, outside: `${RUN}-outside` };
const workspaceIds = Object.values(ws);
const clientId = `${RUN}-client`;
const t = createTranslator({ locale: "en", messages: en, namespace: "settings" }) as unknown as AuditTranslator;

/** The events of an action in a workspace, newest first. */
async function events(workspaceId: string, action: string) {
  return db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, action)))
    .orderBy(auditEvent.createdAt);
}

/** The one latest event of an action, checked to exist. */
async function latest(workspaceId: string, action: string) {
  const rows = await events(workspaceId, action);
  const row = rows.at(-1);
  check(row, `${action} is recorded`);
  return row;
}

const describe = (row: typeof auditEvent.$inferSelect) =>
  describeAuditEvent({ action: row.action, targetLabel: row.targetLabel, details: row.details as Record<string, unknown> }, t);

const filters = (query: Record<string, string> = {}): AuditFilters => parseAuditFilters(query);

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: names[id], email: email(id), emailVerified: true })));
  await db.insert(workspace).values(workspaceIds.map((id) => ({ id, name: id === ws.main ? "Acme" : id })));
  await db.insert(workspaceMember).values([
    { workspaceId: ws.main, userId: ids.owner, role: "owner" as const },
    { workspaceId: ws.main, userId: ids.bob, role: "member" as const },
    { workspaceId: ws.main, userId: ids.gus, role: "guest" as const },
    { workspaceId: ws.other, userId: ids.owner, role: "owner" as const },
    { workspaceId: ws.other, userId: ids.bob, role: "member" as const },
    { workspaceId: ws.other, userId: ids.nora, role: "member" as const },
  ]);
  const { owner, bob, gus, nora, carl, sam, olly, lina } = ids;

  // ── Members and roles ────────────────────────────────────────────────────────────────────────
  await addMember(owner, ws.main, email(nora), "member");
  let row = await latest(ws.main, "member.added");
  check(
    row.actorKind === "user" && row.actorUserId === owner && row.actorName === names[owner] && row.actorEmail === email(owner),
    "an owner adding a member is recorded as that person",
    row,
  );
  check(row.targetId === nora && row.targetLabel === names[nora] && (row.details as { role?: string }).role === "member", "…naming who and as what", row);
  check(row.ip === null && row.userAgent === null, "…without an address outside a request", row);
  check(describe(row) === `Added ${names[nora]} as member`, "…and reads as a sentence", describe(row));

  await setMemberRole(owner, ws.main, nora, "guest");
  row = await latest(ws.main, "member.role_changed");
  check(describe(row) === `Changed the role of ${names[nora]} from member to guest`, "a role change is recorded with before and after", describe(row));
  const roleChanges = (await events(ws.main, "member.role_changed")).length;
  await setMemberRole(owner, ws.main, nora, "guest");
  check((await events(ws.main, "member.role_changed")).length === roleChanges, "setting the same role again records nothing");

  await removeMember(owner, ws.main, nora);
  row = await latest(ws.main, "member.removed");
  check(row.targetId === nora && (row.details as { role?: string }).role === "guest", "removing someone is recorded with their role", row);

  await transferOwnership(owner, ws.other, bob);
  row = await latest(ws.other, "member.ownership_transferred");
  check(row.actorUserId === owner && row.targetId === bob, "handing over ownership is recorded", row);
  await removeMember(nora, ws.other, nora);
  row = await latest(ws.other, "member.left");
  check(row.actorUserId === nora && row.targetId === nora, "leaving is recorded as the person who left", row);
  await db.insert(user).values({ id: leaver, name: "Leaver", email: email(leaver), emailVerified: true });
  await db.insert(workspaceMember).values({ workspaceId: ws.other, userId: leaver, role: "member" });
  await db.transaction((tx) => withdrawFromWorkspaces(tx, leaver));
  row = await latest(ws.other, "member.left");
  check(
    row.targetId === leaver &&
      (row.details as { role?: string; via?: string }).role === "member" &&
      (row.details as { via?: string }).via === "account_deleted",
    "leaving by deleting the account is recorded with the role they had",
    row,
  );

  // ── Invitations, the join link, join requests ────────────────────────────────────────────────
  const invitee = `invitee-${RUN}@example.test`;
  const invited = await addMember(owner, ws.main, invitee, "member");
  check(invited.kind === "invited", "an address without an account is invited", invited);
  row = await latest(ws.main, "invitation.sent");
  check(row.targetType === "email" && row.targetLabel === invitee, "the invitation is recorded with the address", row);
  const [invitation] = await db
    .select({ id: workspaceInvitation.id, token: workspaceInvitation.token })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, ws.main), eq(workspaceInvitation.email, invitee)));
  await revokeInvitation(owner, ws.main, invitation.id);
  row = await latest(ws.main, "invitation.revoked");
  check(row.targetLabel === invitee, "revoking it is recorded", row);

  await addMember(owner, ws.main, email(accepter), "member");
  const [accepted] = await db
    .select({ token: workspaceInvitation.token })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, ws.main), eq(workspaceInvitation.email, email(accepter))));
  await db.insert(user).values({ id: accepter, name: names[accepter], email: email(accepter), emailVerified: true });
  await acceptInvitation(accepted.token, accepter, email(accepter));
  row = await latest(ws.main, "invitation.accepted");
  check(
    row.actorUserId === accepter && describe(row) === `Accepted the invitation for ${email(accepter)} and joined as member`,
    "accepting an invitation is recorded as the invitee",
    describe(row),
  );

  await setJoinLink(owner, ws.main, "enable");
  await setJoinLink(owner, ws.main, "enable");
  check((await events(ws.main, "join_link.enabled")).length === 1, "turning on the join link is recorded once, not again while it is on");
  await setJoinLink(owner, ws.main, "regenerate");
  await latest(ws.main, "join_link.regenerated");
  const [link] = await db.select({ token: workspace.inviteLinkToken }).from(workspace).where(eq(workspace.id, ws.main));
  const joined = await joinWithLink(link.token!, lina, email(lina));
  check(joined.status === "joined", "someone joins with the link", joined);
  row = await latest(ws.main, "member.joined");
  check(row.actorUserId === lina && describe(row) === "Joined as member through the join link", "joining with the link is recorded", describe(row));
  await setJoinLink(owner, ws.main, "disable");
  await latest(ws.main, "join_link.disabled");

  await updateWorkspaceSettings(owner, ws.main, { memberInvites: "members_with_approval" });
  const asked = `asked-${RUN}@example.test`;
  await requestInvitation(bob, ws.main, asked, "member");
  await requestToJoinFrom(ws.main, olly, email(olly), "link");
  const requests = await listJoinRequests(owner, ws.main);
  const inviteRequest = requests.find((r) => r.kind === "invite");
  const joinRequest = requests.find((r) => r.kind === "join");
  check(inviteRequest && joinRequest, "a member's invite request and someone's join request wait", requests);
  await approveJoinRequest(owner, ws.main, inviteRequest.id);
  row = await latest(ws.main, "join_request.approved");
  check(describe(row) === `Approved the request to invite ${asked} as member`, "approving an invite request is recorded", describe(row));
  await declineJoinRequest(owner, ws.main, joinRequest.id);
  row = await latest(ws.main, "join_request.declined");
  check(row.targetId === olly && describe(row) === `Declined the request of ${names[olly]} to join`, "declining a join request is recorded", describe(row));
  await updateWorkspaceSettings(owner, ws.main, { memberInvites: "owners" });

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────
  const settingEvents = await events(ws.main, "workspace.settings_changed");
  check(settingEvents.length === 2, "each settings change is one event", settingEvents.length);
  check(
    isDeepStrictEqual((settingEvents[0].details as { changes: unknown }).changes, { memberInvites: { from: "owners", to: "members_with_approval" } }),
    "…holding only the changed keys, with before and after",
    settingEvents[0].details,
  );
  await updateWorkspaceSettings(owner, ws.main, { memberInvites: "owners", export: true });
  check((await events(ws.main, "workspace.settings_changed")).length === 2, "saving settings without a change records nothing");
  await updateWorkspaceSettings(owner, ws.main, { trashRetentionDays: 7, publishing: "owners" });
  row = await latest(ws.main, "workspace.settings_changed");
  const changed = describe(row);
  check(
    changed.startsWith("Changed settings: ") &&
      changed.includes("Delete pages in the trash after: 30 days → 7 days") &&
      changed.includes("Who can publish to the web: Owners and members → Owners only"),
    "the change reads with the settings' names and values",
    changed,
  );
  await updateWorkspaceSettings(owner, ws.main, { publishing: "members" });
  await renameWorkspace(owner, ws.main, "Acme Inc");
  row = await latest(ws.main, "workspace.renamed");
  check(describe(row) === "Renamed the workspace from Acme to Acme Inc", "renaming the workspace is recorded", describe(row));

  // ── Page sharing and access requests ─────────────────────────────────────────────────────────
  const plan = await createPage({ userId: owner }, { workspaceId: ws.main, title: "Plan" });
  // Someone keeps full access when everyone's level goes down.
  await setPagePermission(owner, plan.id, owner, "full");
  await setPagePermission(owner, plan.id, bob, "edit");
  row = await latest(ws.main, "page.permission_changed");
  check(describe(row) === `Set the access of ${names[bob]} to Plan: Can edit`, "sharing with a person is recorded", describe(row));
  await setPagePermission(owner, plan.id, null, "view");
  row = await latest(ws.main, "page.permission_changed");
  check(describe(row) === "Set the access of everyone in the workspace to Plan: Can view", "changing what everyone gets is recorded", describe(row));
  const sharing = (await events(ws.main, "page.permission_changed")).length;
  await setPagePermission(owner, plan.id, bob, "edit");
  check((await events(ws.main, "page.permission_changed")).length === sharing, "setting the same level again records nothing");
  await removePagePermission(owner, plan.id, bob);
  row = await latest(ws.main, "page.permission_removed");
  check((row.details as { subjectId?: string }).subjectId === bob, "removing someone's entry is recorded", row);

  const group = await createGroup(owner, ws.main, "Design", [bob]);
  await setPageGroupPermission(owner, plan.id, group.id, "comment");
  row = await latest(ws.main, "page.permission_changed");
  check(describe(row) === "Set the access of Design to Plan: Can comment", "sharing with a group is recorded", describe(row));
  await removePageGroupPermission(owner, plan.id, group.id);
  row = await latest(ws.main, "page.permission_removed");
  check((row.details as { subjectType?: string }).subjectType === "group", "removing a group's entry is recorded", row);

  const outsideAddress = `shared-${RUN}@example.test`;
  await sharePageByEmail(owner, plan.id, outsideAddress, "view");
  row = await latest(ws.main, "page.permission_changed");
  check((row.details as { subject?: string }).subject === outsideAddress, "sharing with an address is recorded", row);
  await removePageInvitation(owner, plan.id, outsideAddress);
  row = await latest(ws.main, "page.permission_removed");
  check((row.details as { subject?: string }).subject === outsideAddress, "…and taking it back", row);

  const secret = await createPage({ userId: owner }, { workspaceId: ws.main, title: "Secret" });
  await setPagePermission(owner, secret.id, owner, "full");
  await setPagePermission(owner, secret.id, null, "none");

  check((await requestPageAccess(bob, secret.id, "please")) === "sent", "a member asks for a page they can't see");
  let pending = await listAccessRequests(owner, secret.id);
  await approveAccessRequest(owner, pending[0].id, "comment");
  row = await latest(ws.main, "access_request.approved");
  check(describe(row) === `Approved the access request of ${names[bob]} for Secret: Can comment`, "approving an access request is recorded", describe(row));
  await requestPageAccess(gus, secret.id);
  pending = await listAccessRequests(owner, secret.id);
  await declineAccessRequest(owner, pending[0].id);
  row = await latest(ws.main, "access_request.declined");
  check((row.details as { subjectId?: string }).subjectId === gus, "declining one is recorded", row);

  // ── Teamspaces and groups ────────────────────────────────────────────────────────────────────
  const team = await createTeamspace(owner, ws.main, { name: "Design team", access: "closed" });
  row = await latest(ws.main, "teamspace.created");
  check(row.targetId === team.id && describe(row) === "Created the teamspace Design team", "creating a teamspace is recorded", describe(row));
  await updateTeamspace(owner, team.id, { name: "Product team", description: "Ships things" });
  row = await latest(ws.main, "teamspace.updated");
  check(describe(row) === "Changed the name, description of the teamspace Product team", "changing a teamspace names what changed", describe(row));
  await addTeamspaceMembers(owner, team.id, [bob]);
  row = await latest(ws.main, "teamspace.member_added");
  check(describe(row) === `Added ${names[bob]} to the teamspace Product team as member`, "adding teamspace members is recorded", describe(row));
  await setTeamspaceRole(owner, team.id, bob, "owner");
  row = await latest(ws.main, "teamspace.role_changed");
  check(describe(row) === `Changed the role of ${names[bob]} in the teamspace Product team to teamspace owner`, "a teamspace role is recorded", describe(row));
  await removeTeamspaceMember(owner, team.id, bob);
  await latest(ws.main, "teamspace.member_removed");
  await addTeamspaceGroups(owner, team.id, [group.id]);
  row = await latest(ws.main, "teamspace.group_added");
  check(describe(row) === "Added the groups Design to the teamspace Product team", "adding a group to a teamspace is recorded", describe(row));
  await removeTeamspaceGroup(owner, team.id, group.id);
  await latest(ws.main, "teamspace.group_removed");
  await setTeamspaceArchived(owner, team.id, true);
  await setTeamspaceArchived(owner, team.id, true);
  check((await events(ws.main, "teamspace.archived")).length === 1, "archiving a teamspace is recorded once");
  await setTeamspaceArchived(owner, team.id, false);
  await latest(ws.main, "teamspace.restored");

  row = await latest(ws.main, "group.created");
  check(describe(row) === "Created the group Design", "creating a group is recorded", describe(row));
  await changeGroup(owner, group.id, { name: "Designers", add: [owner], remove: [bob] });
  row = await latest(ws.main, "group.renamed");
  check(describe(row) === "Renamed the group Design to Designers", "renaming a group is recorded", describe(row));
  row = await latest(ws.main, "group.members_added");
  check(describe(row).startsWith(`Added ${names[owner]} to the group `), "adding group members is recorded", describe(row));
  row = await latest(ws.main, "group.members_removed");
  check(describe(row).startsWith(`Removed ${names[bob]} from the group `), "removing group members is recorded", describe(row));
  await deleteGroup(owner, group.id);
  row = await latest(ws.main, "group.deleted");
  check(row.targetLabel === "Designers", "deleting a group keeps its name in the log", row);

  // ── Single sign-on and SCIM ──────────────────────────────────────────────────────────────────
  const discover = async (issuer: string) => ({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/jwks`,
    tokenEndpointAuthentication: "client_secret_basic" as const,
  });
  await saveSsoConnection(
    owner,
    ws.main,
    { protocol: "oidc", issuer: "https://idp.example.com", clientId: "c", clientSecret: "s", domains: DOMAIN },
    { discover },
  );
  row = await latest(ws.main, "sso.configured");
  check(describe(row) === `Saved the single sign-on connection (OIDC) for ${DOMAIN}`, "saving single sign-on is recorded", describe(row));
  check(!JSON.stringify(row.details).includes('"s"'), "…without its client secret", row.details);
  const [sso] = await db.execute<{ token: string }>(
    (await import("drizzle-orm")).sql`select verification_token as token from workspace_sso where workspace_id = ${ws.main}`,
  );
  await verifySsoDomains(owner, ws.main, async (name) => (name === domainRecordName(DOMAIN) ? [[`leafdesk-sso=${sso.token}`]] : []));
  await latest(ws.main, "sso.domains_verified");

  const scim = await createScimToken(owner, ws.main, "Okta");
  row = await latest(ws.main, "scim.token_created");
  check(row.targetLabel === "Okta" && !JSON.stringify(row).includes(scim.secret), "creating a SCIM token is recorded, never its secret", row);
  const scimRequest = (method: string, path: string, body?: unknown) =>
    handleScimRequest(
      new Request(`${env.appUrl}/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${scim.secret}`,
          "content-type": "application/scim+json",
          "user-agent": "Okta SCIM Client",
          [CLIENT_IP_HEADER]: "192.0.2.10",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const provisioned = await scimRequest("POST", "/Users", { userName: email(sam) });
  check(provisioned.status === 201, "the identity provider brings someone in over SCIM", provisioned.status);
  row = await latest(ws.main, "member.added");
  check(
    row.targetId === sam && row.actorKind === "scim" && row.actorUserId === null && row.actorVia === "Okta",
    "…recorded as the identity provider, through its token",
    row,
  );
  check(row.ip === "192.0.2.10" && row.userAgent === "Okta SCIM Client", "…from the address of its request", row);
  const off = await scimRequest("PATCH", `/Users/${sam}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active: false } }],
  });
  check(off.status === 200, "…and deactivates them", off.status);
  row = await latest(ws.main, "member.removed");
  check(row.targetId === sam && row.actorKind === "scim" && (row.details as { via?: string }).via === "scim", "deactivating over SCIM is recorded as the identity provider", row);
  await revokeScimToken(owner, ws.main, scim.token.id);
  row = await latest(ws.main, "scim.token_revoked");
  check(row.actorKind === "user" && row.targetLabel === "Okta", "revoking a SCIM token is recorded", row);
  await removeSsoConnection(owner, ws.main);
  await latest(ws.main, "sso.removed");

  // ── Deleting, publishing, the site ───────────────────────────────────────────────────────────
  const draft = await createPage({ userId: owner }, { workspaceId: ws.main, title: "Draft" });
  await archivePage(owner, draft.id);
  await deletePagePermanently(owner, draft.id);
  row = await latest(ws.main, "page.deleted");
  check(row.actorKind === "user" && row.actorUserId === owner && describe(row) === "Deleted Draft for good", "deleting a page for good is recorded", row);

  const notes = await createPage({ userId: bob }, { workspaceId: ws.main, title: "Notes" });
  await publishPage(bob, notes.id);
  await publishPage(bob, notes.id);
  check((await events(ws.main, "page.published")).length === 1, "publishing is recorded once, not when already published");
  await unpublishPage(bob, notes.id);
  await latest(ws.main, "page.unpublished");
  await publishPage(bob, notes.id);
  await revokePublication(owner, ws.main, notes.id);
  row = await latest(ws.main, "page.publication_revoked");
  check(describe(row) === `Took Notes off the web (published by ${names[bob]})`, "an owner taking a page off the web is recorded", describe(row));

  const slug = `audit-${Date.now().toString(36)}`;
  await saveSite(owner, ws.main, { slug, title: "Acme", homePageId: null });
  row = await latest(ws.main, "site.saved");
  check(describe(row) === `Saved the site at ${slug}`, "saving the site is recorded", describe(row));
  await removeSite(owner, ws.main);
  await latest(ws.main, "site.removed");

  // ── API tokens and connected apps ────────────────────────────────────────────────────────────
  const scoped = await createApiToken(owner, { name: "CI", scopes: ["pages:read", "pages:write"], workspaceId: ws.main });
  row = await latest(ws.main, "api_token.created");
  check(row.targetLabel === "CI" && !JSON.stringify(row).includes(scoped.secret), "creating an API token is recorded, never its secret", row);
  check((await events(ws.other, "api_token.created")).length === 0, "…only in the workspace it is for");
  const everywhere = await createApiToken(owner, { name: "Everywhere", scopes: ["pages:read"] });
  check(
    (await events(ws.main, "api_token.created")).length === 2 && (await events(ws.other, "api_token.created")).length === 1,
    "a token for all workspaces is recorded in each of them",
  );
  await revokeApiToken(owner, everywhere.token.id);
  await latest(ws.other, "api_token.revoked");

  // A change made through the REST API is the person's, through their token.
  await runAsConnectedApp(
    { userId: owner, writing: true, app: { kind: "api_token", id: scoped.token.id, ip: "198.51.100.8", userAgent: "curl/8" } },
    () => createGroup(owner, ws.main, "From the API"),
  );
  row = await latest(ws.main, "group.created");
  check(
    row.actorKind === "api_token" && row.actorUserId === owner && row.actorVia === "CI" && row.ip === "198.51.100.8",
    "a change through an API token names the person and the token",
    row,
  );

  // A change made by an MCP client (a connected app) is the person's, through that app.
  const now = new Date();
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Audit AI", redirectUris: [] });
  await db.insert(oauthConsent).values({ id: clientId, clientId, userId: owner, scopes: ["openid", "pages:write"], createdAt: now, updatedAt: now });
  await runAsConnectedApp(
    { userId: owner, writing: true, app: { kind: "connected_app", id: clientId, ip: "198.51.100.7", userAgent: "AuditAI/1.0" } },
    () => addMembers(owner, ws.main, [email(carl)], "member"),
  );
  row = await latest(ws.main, "member.added");
  check(
    row.targetId === carl && row.actorKind === "connected_app" && row.actorUserId === owner && row.actorVia === "Audit AI",
    "a change through a connected app names the person and the app",
    row,
  );
  check(row.ip === "198.51.100.7" && row.userAgent === "AuditAI/1.0", "…from the address of the app's request", row);
  await revokeConnectedApp(owner, clientId);
  row = await latest(ws.main, "connected_app.revoked");
  check(row.targetLabel === "Audit AI" && (await events(ws.other, "connected_app.revoked")).length === 1, "disconnecting an app is recorded in each workspace", row);

  // ── Exports ──────────────────────────────────────────────────────────────────────────────────
  const tasks = await createPage({ userId: owner }, { workspaceId: ws.main, kind: "database", title: "Tasks" });
  await databaseCsv(owner, tasks.id);
  row = await latest(ws.main, "export.page");
  check(describe(row) === "Exported Tasks as CSV", "a database CSV is recorded", describe(row));
  await printDocument(owner, plan.id);
  row = await latest(ws.main, "export.page");
  check(describe(row) === "Exported Plan as PDF", "the print view is recorded as a PDF export", describe(row));
  const release = startExport(owner);
  const archive = await archiveResponse(owner, await planExport(owner, { workspaceId: ws.main }), ENGLISH_EXPORT_LABELS, release);
  await archive.arrayBuffer();
  row = await latest(ws.main, "export.workspace");
  check(
    row.actorUserId === owner && (row.details as { format?: string }).format === "zip" && /^Exported the workspace \(\d+ pages?\)$/.test(describe(row)),
    "a workspace export is recorded",
    describe(row),
  );

  // ── A failing recording never fails the change ───────────────────────────────────────────────
  const renames = (await events(ws.main, "workspace.renamed")).length;
  failAuditWritesForTesting(true);
  try {
    await renameWorkspace(owner, ws.main, "Acme Renamed");
    const board = await createPage({ userId: owner }, { workspaceId: ws.main, title: "Board" });
    await publishPage(owner, board.id);
    const [named] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, ws.main));
    check(named.name === "Acme Renamed", "a change recorded in its transaction stands when recording fails");
    const [published] = await db.select().from(pagePublication).where(eq(pagePublication.pageId, board.id));
    check(published, "a change recorded after it commits stands when recording fails");
  } finally {
    failAuditWritesForTesting(false);
  }
  check((await events(ws.main, "workspace.renamed")).length === renames, "…and nothing is recorded");

  // ── Retention cleanup: deletes by the system ─────────────────────────────────────────────────
  const old = await createPage({ userId: owner }, { workspaceId: ws.main, title: "Old draft" });
  await archivePage(owner, old.id);
  await db.update(page).set({ archivedAt: new Date(now.getTime() - 10 * DAY) }).where(eq(page.id, old.id));

  // ── Owners only ──────────────────────────────────────────────────────────────────────────────
  for (const [who, label] of [
    [bob, "a member"],
    [gus, "a guest"],
    [olly, "someone outside the workspace"],
  ] as const) {
    await rejects(() => listAuditEvents(who, ws.main, filters()), isAccess, `${label} can't list the log`);
    await rejects(() => auditEventsForExport(who, ws.main, filters()), isAccess, `${label} can't download it`);
    await rejects(() => auditActors(who, ws.main), isAccess, `${label} can't list who acted`);
  }
  await rejects(() => listAuditEvents(owner, `${RUN}-missing`, filters()), isAccess, "a workspace that doesn't exist is refused the same way");
  const firstPage = await listAuditEvents(owner, ws.main, filters());
  check(firstPage.events.length > 0 && firstPage.events[0].action !== undefined, "the owner lists the log");
  const actors = await auditActors(owner, ws.main);
  check(actors.some((a) => a.userId === owner) && actors.some((a) => a.userId === lina), "…and who acted in it", actors);
  check(!actors.some((a) => a.userId === nora), "…in this workspace only", actors);


  // ── Filters and paging (synthetic events in their own workspace) ─────────────────────────────
  // 120 events an hour apart, the newest at noon (UTC) a month ago: the owner's and Bora's by
  // turns, every tenth by the system, in turn a member added, a group created and a setting changed.
  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30, 12));
  /** The calendar day (UTC) `days` before the newest event's. */
  const dayOf = (days: number) => new Date(base.getTime() - days * DAY).toISOString().slice(0, 10);
  // Its people join only now, so none of the changes above (tokens and apps are recorded in all
  // of a person's workspaces) is in it.
  await db.insert(workspaceMember).values([
    { workspaceId: ws.log, userId: owner, role: "owner" as const },
    { workspaceId: ws.log, userId: bob, role: "member" as const },
  ]);
  const synthetic = Array.from({ length: 120 }, (_, i) => {

    const system = i % 10 === 0;
    const actor = system ? null : i % 2 ? bob : owner;
    return {
      workspaceId: ws.log,
      actorUserId: actor,
      actorKind: system ? ("system" as const) : ("user" as const),
      actorName: actor ? names[actor] : "",
      actorEmail: actor ? email(actor) : null,
      action: ["member.added", "group.created", "workspace.settings_changed"][i % 3],
      targetLabel: `Item ${i}`,
      createdAt: new Date(base.getTime() - i * 60 * 60 * 1000),
    };
  });
  await db.insert(auditEvent).values(synthetic);
  const p1 = await listAuditEvents(owner, ws.log, filters());
  check(p1.events.length === AUDIT_PAGE_SIZE && p1.hasMore, "a page holds 50 events and says more follow", p1.events.length);
  check(p1.events[0].targetLabel === "Item 0" && p1.events[49].targetLabel === "Item 49", "…newest first", [p1.events[0].targetLabel, p1.events[49].targetLabel]);
  const p3 = await listAuditEvents(owner, ws.log, filters({ page: "3" }));
  check(p3.events.length === 20 && !p3.hasMore && p3.events[19].targetLabel === "Item 119", "the last page holds the rest", p3.events.length);
  const p2 = await listAuditEvents(owner, ws.log, filters({ page: "2" }));
  const seen = new Set([...p1.events, ...p2.events, ...p3.events].map((e) => e.id));
  check(seen.size === 120, "pages don't overlap or skip");

  const groups = await listAuditEvents(owner, ws.log, filters({ category: "groups" }));
  check(groups.events.length === 40 && groups.events.every((e) => e.action === "group.created"), "the category filter keeps its actions", groups.events.length);
  const byBob = await auditEventsForExport(owner, ws.log, filters({ actor: `u:${bob}` }));
  check(byBob.length === synthetic.filter((e) => e.actorUserId === bob).length && byBob.every((e) => e.actorUserId === bob), "the actor filter keeps one person's events", byBob.length);
  const bySystem = await auditEventsForExport(owner, ws.log, filters({ actor: "k:system" }));
  check(bySystem.length === 12 && bySystem.every((e) => e.actorKind === "system"), "…or the server's", bySystem.length);
  const scimOnly = await auditEventsForExport(owner, ws.main, filters({ actor: "k:scim" }));
  check(scimOnly.length === 2 && scimOnly.every((e) => e.actorKind === "scim"), "…or the identity provider's", scimOnly.length);

  // Items 0-12 are on the newest event's day (noon back to midnight, UTC), 13-36 on the day
  // before, 37-60 on the one before that.
  const day = await auditEventsForExport(owner, ws.log, filters({ from: dayOf(1), to: dayOf(1) }));
  check(day.length === 24 && day[0].targetLabel === "Item 13" && day[23].targetLabel === "Item 36", "a one-day range keeps that whole day", day.length);
  const range = await auditEventsForExport(owner, ws.log, filters({ from: dayOf(2), to: dayOf(1) }));
  check(range.length === 48 && range.at(-1)?.targetLabel === "Item 60", "a range includes both ends", range.length);
  // In Istanbul (UTC+3) the newest event's day starts at 21:00 UTC the day before: items 0-15.
  const istanbul = await auditEventsForExport(owner, ws.log, filters({ from: dayOf(0), to: dayOf(0) }), { timeZone: "Europe/Istanbul" });
  check(istanbul.length === 16 && istanbul.at(-1)?.targetLabel === "Item 15", "days are the viewer's", istanbul.length);
  const combined = await auditEventsForExport(owner, ws.log, filters({ actor: `u:${owner}`, category: "members", from: dayOf(1), to: dayOf(0) }));
  check(
    combined.length > 0 && combined.length === synthetic.filter((e, i) => i <= 36 && e.actorUserId === owner && e.action === "member.added").length,
    "filters combine",
    combined.length,
  );

  const beyond = await listAuditEvents(owner, ws.log, filters({ page: "9" }));
  check(beyond.events.length === 0 && !beyond.hasMore, "a page past the end is empty");

  // The CSV: the filtered events, all pages, with a header.
  const csvEvents: AuditEvent[] = await auditEventsForExport(owner, ws.log, filters({ category: "settings" }));
  const csv = toCsv(auditCsvRows(csvEvents, t));
  const lines = csv.trim().split("\r\n");
  check(csvEvents.length === 40 && lines.length === 41, "the CSV holds every filtered event, not a page", lines.length);
  check(lines[0].endsWith("time,actor,actor_email,actor_type,via,action,category,description,target,ip,user_agent,details"), "…under a header", lines[0]);
  check(lines[1].includes(",workspace.settings_changed,settings,"), "…with the action and its category", lines[1]);

  // ── Retention: a year of events, only in the workspaces of the run ───────────────────────────
  const aged = (workspaceId: string, days: number) => ({
    workspaceId,
    actorKind: "system" as const,
    action: "page.deleted",
    targetLabel: `Aged ${days}`,
    createdAt: new Date(now.getTime() - days * DAY),
  });
  await db.insert(auditEvent).values([aged(ws.log, 400), aged(ws.log, 380), aged(ws.log, 366), aged(ws.log, 364), aged(ws.outside, 400), aged(ws.outside, 500)]);
  const result = await runRetention({ now, workspaceIds: [ws.main, ws.other, ws.log] });
  check(result && result.auditEvents === 3, "the cleanup prunes events older than a year", result);
  const kept = await db.select({ label: auditEvent.targetLabel }).from(auditEvent).where(and(eq(auditEvent.workspaceId, ws.log), eq(auditEvent.action, "page.deleted")));
  check(kept.length === 1 && kept[0].label === "Aged 364", "…keeping those younger than a year", kept);
  const outside = await db.select({ id: auditEvent.id }).from(auditEvent).where(eq(auditEvent.workspaceId, ws.outside));
  check(outside.length === 2, "…and leaving workspaces outside the run alone", outside.length);
  check((await pruneAuditEvents({ now, workspaceIds: [] })) === 0, "a run naming no workspace prunes nothing");
  check((await pruneAuditEvents({ now, workspaceIds: [ws.outside] })) === 2, "pruning a workspace takes its old events");

  row = await latest(ws.main, "page.deleted");
  check(
    row.targetId === old.id && row.actorKind === "system" && row.actorUserId === null && describe(row) === "Deleted Old draft for good",
    "the trash cleanup's deletes are recorded as the system",
    row,
  );
  const [gone] = await db.select({ id: page.id }).from(page).where(eq(page.id, old.id));
  check(!gone, "…which deleted the page");

  // ── Agents: shown as agents, never with their address ───────────────────────────────────────
  const helper = await createAgent(ids.owner, ws.main, { name: "Helper", icon: "🤖" });
  agentUsers.push(helper.userId);
  const created = await latest(ws.main, "agent.created");
  check(
    created.actorKind === "user" && created.targetLabel === "Helper" && !JSON.stringify(created.details).includes("@"),
    "creating an agent is an owner's change that names the agent, without its address",
    created,
  );
  const agentDraft = await createPage({ userId: ids.owner }, { workspaceId: ws.main, title: "Agent draft" });
  await recordAudit({ workspaceId: ws.main, actorId: helper.userId, action: "page.deleted", target: { type: "page", id: agentDraft.id } });
  const byAgent = await latest(ws.main, "page.deleted");
  check(
    byAgent.actorKind === "agent" && byAgent.actorUserId === helper.userId && byAgent.actorEmail === null && auditActorName(byAgent, t) === "Helper (agent)",
    "what an agent does is recorded as the agent's, without an address",
    byAgent,
  );
  const agentEvents = await listAuditEvents(ids.owner, ws.main, filters({ actor: "k:agent" }));
  check(agentEvents.events.length === 1 && agentEvents.events[0].id === byAgent.id, "the log filters on agents", agentEvents.events.length);
  const helperOption = (await auditActors(ids.owner, ws.main)).find((a) => a.userId === helper.userId);
  check(helperOption?.isAgent === true && helperOption.email === null, "the actor filter names the agent as one", helperOption);

  // ── Descriptions of everything recorded here ─────────────────────────────────────────────────
  const all = await db.select().from(auditEvent).where(inArray(auditEvent.workspaceId, [ws.main, ws.other]));
  const unreadable = all.filter((e) => {
    const text = describe(e);
    return text === e.action || /[{}]/.test(text);
  });
  check(unreadable.length === 0, "every recorded event reads as a sentence", unreadable.map((e) => e.action));
  const families = new Set(all.map((e) => e.action.split(".")[0]));
  check(
    ["member", "invitation", "join_link", "join_request", "page", "access_request", "teamspace", "group", "workspace", "sso", "scim", "site", "api_token", "connected_app", "export"].every(
      (family) => families.has(family),
    ),
    "every family of changes was recorded",
    [...families],
  );
  const kinds = new Set(all.map((e) => e.actorKind));
  check(AUDIT_ACTOR_KINDS.every((kind) => kinds.has(kind)), "…by every kind of actor", [...kinds]);

  console.log(`\n${passed} checks passed.`);
} finally {
  failAuditWritesForTesting(false);
  await db.delete(workspaceSite).where(inArray(workspaceSite.workspaceId, workspaceIds));
  await db.delete(pagePublication).where(inArray(pagePublication.publishedBy, userIds));
  await db.delete(oauthClient).where(eq(oauthClient.id, clientId));
  await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, [...userIds, ...agentUsers]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

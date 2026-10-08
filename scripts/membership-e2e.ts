/**
 * End-to-end check of membership policies against the database (issue #56): who may add members
 * (owners only, members with an owner's approval, any member), allowed email domains joining or
 * asking on sign-in and from the workspace switcher, verified and unverified addresses, people who
 * left or were removed, the join link asking an owner, one pending request per person, rate limits,
 * owners approving and declining both kinds of request, their inbox and emails, the emails the
 * person who asked gets, and who each membership records as having invited them (nobody for those
 * who came in on their own). Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/membership-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, user, workspace, workspaceInvitation, workspaceJoinRequest, workspaceMember } = await import("@/db/schema");
const { AccessError } = await import("@/server/access");
const {
  applyDomainPolicies,
  approveJoinRequest,
  declineJoinRequest,
  joinableWorkspaces,
  joinFromSwitcher,
  listJoinRequests,
  setJoinRequestMailer,
} = await import("@/server/join-requests");
const { listInbox } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const {
  addMember,
  addMembers,
  joinLinkAccess,
  joinWithLink,
  memberInviteAccess,
  removeMember,
  setJoinLink,
  setMemberRole,
  updateWorkspaceSettings,
  WorkspaceError,
} = await import("@/server/workspaces");

const { registerCollab } = await import("@/server/collab/bridge");

const RUN = `membership-e2e-${Date.now().toString(36)}`;

// Removing a member closes their open editors through the collab service, which only runs inside
// the app server; nothing is open here.
registerCollab({
  broadcast() {},
  async disconnectUser() {},
  async disconnectLostAccess() {},
  async disconnectHeldBack() {},
} as unknown as Parameters<typeof registerCollab>[0]);
// A domain of the run's own, so no other workspace in the database allows it.
const DOMAIN = `${RUN}.example`;

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
const isCode = (code: string) => (error: unknown) => error instanceof WorkspaceError && error.code === code;

type Person = { id: string; email: string; verified: boolean };
const person = (name: string, email: string, verified = true): Person => ({ id: `${RUN}-${name}`, email, verified });
const people = {
  owner: person("owner", `owner@${RUN}.test`),
  owner2: person("owner2", `owner2@${RUN}.test`),
  member: person("member", `member@${RUN}.test`),
  guest: person("guest", `guest@${RUN}.test`),
  invitee: person("invitee", `invitee@${RUN}.test`),
  dana: person("dana", `dana@${DOMAIN}`),
  sub: person("sub", `sub@eu.${DOMAIN}`),
  ursula: person("ursula", `ursula@${DOMAIN}`, false),
  rita: person("rita", `rita@${DOMAIN}`),
  vera: person("vera", `vera@${DOMAIN}`),
  outsider: person("outsider", `outsider@other-${RUN}.test`),
  linker: person("linker", `linker@other-${RUN}.test`, false),
  lookalike: person("lookalike", `look@not${DOMAIN}`),
};
const userIds = Object.values(people).map((p) => p.id);
const workspaceId = `${RUN}-ws`;

const decisionMails: { to: string; subject: string; text: string }[] = [];
const ownerMails: { to: string; subject: string; text: string }[] = [];
setJoinRequestMailer(async (mail) => void decisionMails.push(mail));
setShareMailer(async (mail) => void ownerMails.push(mail));

const isMember = async (p: Person) =>
  (
    await db
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, p.id)))
  )[0]?.role ?? null;

/** Who the membership says brought them in (`workspace_member.invited_by`). */
const inviterOf = async (p: Person) =>
  (
    await db
      .select({ invitedBy: workspaceMember.invitedBy })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, p.id)))
  )[0]?.invitedBy ?? null;

const record = async (p: Person) =>
  (
    await db
      .select({ status: workspaceJoinRequest.status, source: workspaceJoinRequest.source })
      .from(workspaceJoinRequest)
      .where(
        and(
          eq(workspaceJoinRequest.workspaceId, workspaceId),
          eq(workspaceJoinRequest.kind, "join"),
          eq(workspaceJoinRequest.userId, p.id),
        ),
      )
  )[0] ?? null;

const requestsOf = async (email: string) => (await listJoinRequests(people.owner.id, workspaceId)).filter((r) => r.email === email);

const requestNotifications = async (ownerId: string) =>
  db
    .select({ id: notification.id, joinRequestId: notification.joinRequestId, readAt: notification.readAt })
    .from(notification)
    .where(and(eq(notification.userId, ownerId), eq(notification.workspaceId, workspaceId), eq(notification.kind, "join_request")));

const settings = (patch: Parameters<typeof updateWorkspaceSettings>[2]) => updateWorkspaceSettings(people.owner.id, workspaceId, patch);
const joinable = async (p: Person) => (await joinableWorkspaces(p.id)).find((w) => w.id === workspaceId)?.access ?? null;

try {
  await db
    .insert(user)
    .values(Object.values(people).map((p) => ({ id: p.id, name: p.id, email: p.email, emailVerified: p.verified })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: people.owner.id, role: "owner" },
    { workspaceId, userId: people.owner2.id, role: "owner" },
    { workspaceId, userId: people.member.id, role: "member" },
    { workspaceId, userId: people.guest.id, role: "guest" },
  ]);

  // Who can add members: owners only (the default)
  check((await memberInviteAccess(people.owner.id, workspaceId)) === "direct", "owners add members");
  check((await memberInviteAccess(people.member.id, workspaceId)) === null, "by default members can't");
  await rejects(() => addMember(people.member.id, workspaceId, `new1@${RUN}.test`, "member"), isAccessError, "…and adding a member is refused");
  await rejects(() => addMembers(people.member.id, workspaceId, [`new1@${RUN}.test`], "member"), isAccessError, "…in bulk too");
  await rejects(() => addMember(people.guest.id, workspaceId, `new1@${RUN}.test`, "member"), isAccessError, "guests can't add anyone");
  const invited = await addMember(people.owner.id, workspaceId, `new1@${RUN}.test`, "member");
  check(invited.kind === "invited", "an owner invites a new address", invited);

  // Settings are validated and owners-only
  await rejects(() => updateWorkspaceSettings(people.member.id, workspaceId, { memberInvites: "any_member" }), isAccessError, "members can't change who adds members");
  await rejects(() => settings({ memberInvites: "everyone" as never }), isCode("invalidSetting"), "an unknown choice is refused");
  await rejects(
    () => settings({ allowedDomains: ["gmail.com"] }),
    (error) => error instanceof WorkspaceError && error.code === "invalidDomain" && error.detail === "gmail.com",
    "a public mail domain can't be allowed, and the error names it",
  );
  await rejects(() => settings({ allowedDomains: ["not a domain"] }), isCode("invalidDomain"), "neither can something that isn't a domain");
  await settings({ allowedDomains: [`@${DOMAIN.toUpperCase()}`, DOMAIN] });
  const [stored] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId));
  check(JSON.stringify(stored.settings.allowedDomains) === JSON.stringify([DOMAIN]), "allowed domains are stored cleaned and once", stored.settings);

  // Members with an owner's approval
  await settings({ memberInvites: "members_with_approval" });
  check((await memberInviteAccess(people.member.id, workspaceId)) === "request", "members may now ask");
  check((await memberInviteAccess(people.guest.id, workspaceId)) === null, "guests still may not");
  await rejects(() => addMember(people.member.id, workspaceId, `new2@${RUN}.test`, "owner"), isAccessError, "members can't ask for the owner role");
  await rejects(() => addMember(people.member.id, workspaceId, `new2@${RUN}.test`, "guest"), isAccessError, "…nor add guests this way");
  const asked = await addMember(people.member.id, workspaceId, `New2@${RUN}.test`, "member");
  check(asked.kind === "requested" && asked.email === `new2@${RUN}.test`, "a member's addition becomes a request", asked);
  check(
    (await db.select().from(workspaceInvitation).where(eq(workspaceInvitation.email, `new2@${RUN}.test`))).length === 0,
    "…and nobody is invited yet",
  );
  await addMember(people.member.id, workspaceId, `new2@${RUN}.test`, "member");
  check((await requestsOf(`new2@${RUN}.test`)).length === 1, "asking again leaves one request per address");
  await rejects(() => addMember(people.member.id, workspaceId, people.owner2.email, "member"), isCode("alreadyMember"), "asking for someone already in says so");
  const bulk = await addMembers(people.member.id, workspaceId, [`new3@${RUN}.test`, "nope"], "member");
  check(bulk[0]?.kind === "requested" && bulk[1]?.kind === "error", "bulk additions by members become requests too", bulk);
  await rejects(() => listJoinRequests(people.member.id, workspaceId), isAccessError, "only owners see the requests");
  const [inviteRequest] = await requestsOf(`new2@${RUN}.test`);
  check(
    inviteRequest.kind === "invite" && inviteRequest.askerEmail === people.member.email && inviteRequest.source === "member",
    "the request names the member who asked",
    inviteRequest,
  );
  const ownerNotes = await requestNotifications(people.owner.id);
  check(
    ownerNotes.some((n) => n.joinRequestId === inviteRequest.id) &&
      (await requestNotifications(people.owner2.id)).some((n) => n.joinRequestId === inviteRequest.id),
    "every owner gets it in their inbox",
  );
  check((await requestNotifications(people.member.id)).length === 0, "…but not the member who asked");
  const inbox = await listInbox(people.owner.id, workspaceId);
  const inboxItem = inbox.find((n) => n.kind === "join_request" && n.requestEmail === `new2@${RUN}.test`);
  check(inboxItem?.requestKind === "invite" && inboxItem.pageId === null && inboxItem.actorName === people.member.id, "the inbox shows who asked to invite whom", inboxItem);
  await flushShareEmails();
  const askMail = ownerMails.find((m) => m.to === people.owner.email && m.subject.includes(`new2@${RUN}.test`));
  check(askMail?.text.includes("settings?tab=members&view=requests"), "owners get an email that links to the requests", askMail);
  check(!ownerMails.some((m) => m.to === people.member.email), "…and the member who asked gets none");

  await rejects(() => approveJoinRequest(people.member.id, workspaceId, inviteRequest.id), isAccessError, "members can't approve");
  await rejects(() => approveJoinRequest(people.guest.id, workspaceId, inviteRequest.id), isAccessError, "guests can't approve");
  const approvedInvite = await approveJoinRequest(people.owner.id, workspaceId, inviteRequest.id);
  const [invitation] = await db
    .select({ invitedBy: workspaceInvitation.invitedBy, role: workspaceInvitation.role })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, `new2@${RUN}.test`)));
  check(approvedInvite?.kind === "invited" && invitation?.invitedBy === people.member.id && invitation.role === "member", "approving sends the invitation in the member's name", { approvedInvite, invitation });
  check((await requestsOf(`new2@${RUN}.test`)).length === 0, "…and the request leaves the list");
  check(!(await requestNotifications(people.owner2.id)).some((n) => n.joinRequestId === inviteRequest.id), "…and the other owners' inboxes");
  check(
    decisionMails.some((m) => m.to === people.member.email && m.subject.includes(`new2@${RUN}.test`) && m.subject.includes("invited")),
    "the member hears that the invitation went out",
    decisionMails,
  );
  await rejects(() => approveJoinRequest(people.owner2.id, workspaceId, inviteRequest.id), isCode("requestHandled"), "a request can't be decided twice");

  await addMember(people.member.id, workspaceId, people.invitee.email, "member");
  const [accountRequest] = await requestsOf(people.invitee.email);
  const added = await approveJoinRequest(people.owner.id, workspaceId, accountRequest.id);
  check(added?.kind === "added" && (await isMember(people.invitee)) === "member", "approving adds someone who already has an account", added);
  check((await inviterOf(people.invitee)) === people.member.id, "…invited by the member who asked", await inviterOf(people.invitee));

  const [declinedInvite] = await requestsOf(`new3@${RUN}.test`);
  await declineJoinRequest(people.owner.id, workspaceId, declinedInvite.id);
  check((await requestsOf(`new3@${RUN}.test`)).length === 0, "declining a member's request removes it");
  check(
    (await db.select().from(workspaceInvitation).where(eq(workspaceInvitation.email, `new3@${RUN}.test`))).length === 0,
    "…without inviting anyone",
  );
  check(
    decisionMails.some((m) => m.to === people.member.email && m.subject.includes(`new3@${RUN}.test`) && !m.text.includes("/settings")),
    "…and the member hears it was declined",
  );
  check((await addMember(people.member.id, workspaceId, `new3@${RUN}.test`, "member")).kind === "requested", "a declined invitation may be asked for again");

  // Any member
  await settings({ memberInvites: "any_member" });
  check((await addMember(people.member.id, workspaceId, `new4@${RUN}.test`, "member")).kind === "invited", "with any member, members invite right away");
  await rejects(() => addMember(people.member.id, workspaceId, `new4@${RUN}.test`, "owner"), isAccessError, "…still never as owners");
  await rejects(() => addMember(people.guest.id, workspaceId, `new4@${RUN}.test`, "member"), isAccessError, "…and guests still can't");
  await settings({ memberInvites: "owners" });

  // Allowed domains: joining on sign-in
  check((await joinable(people.dana)) === "join", "a verified address on the domain sees the workspace to join");
  check((await joinable(people.ursula)) === null, "an unverified one sees nothing while the workspace takes no requests");
  check((await joinable(people.outsider)) === null, "other domains see nothing");
  check((await joinable(people.lookalike)) === null, "a look-alike domain sees nothing");
  check((await applyDomainPolicies(people.ursula.id)).length === 0 && (await isMember(people.ursula)) === null, "an unverified address never joins on its own");
  check((await applyDomainPolicies(people.lookalike.id)).length === 0, "a look-alike domain doesn't join");
  check((await applyDomainPolicies(people.dana.id)).includes(workspaceId), "signing in joins the workspace of a verified allowed domain");
  check((await inviterOf(people.dana)) === null, "…invited by nobody");
  check((await isMember(people.dana)) === "member" && (await record(people.dana))?.status === "accepted", "…as a member, remembered");
  check((await applyDomainPolicies(people.sub.id)).includes(workspaceId), "subdomains of an allowed domain join too");

  // Leaving and removal
  await removeMember(people.dana.id, workspaceId, people.dana.id);
  check((await record(people.dana))?.status === "accepted", "leaving is remembered");
  check((await applyDomainPolicies(people.dana.id)).length === 0 && (await isMember(people.dana)) === null, "signing in again doesn't bring someone who left back");
  check((await joinable(people.dana)) === "join", "…but they may rejoin from the switcher");
  check((await joinFromSwitcher(people.dana.id, workspaceId)) === "joined" && (await isMember(people.dana)) === "member", "…and do");
  await removeMember(people.owner.id, workspaceId, people.sub.id);
  check((await record(people.sub))?.status === "declined", "an owner's removal is remembered as declined");
  check((await applyDomainPolicies(people.sub.id)).length === 0 && (await isMember(people.sub)) === null, "someone removed doesn't come back on sign-in");
  check((await joinable(people.sub)) === null, "…nor sees the workspace while it takes no requests");
  await rejects(() => joinFromSwitcher(people.sub.id, workspaceId), isAccessError, "…and can't join from the switcher");
  await rejects(() => joinFromSwitcher(people.outsider.id, workspaceId), isAccessError, "other domains can't join from the switcher");

  // Allowed domains: asking on sign-in
  await settings({ domainJoin: "request" });
  check((await applyDomainPolicies(people.rita.id)).length === 0 && (await isMember(people.rita)) === null, "with asking, signing in doesn't join");
  const [ritaRequest] = await requestsOf(people.rita.email);
  check(ritaRequest?.kind === "join" && ritaRequest.source === "domain", "…it files a request from the domain", ritaRequest);
  await applyDomainPolicies(people.rita.id);
  check((await requestsOf(people.rita.email)).length === 1, "signing in again keeps one request");
  check((await requestNotifications(people.owner.id)).filter((n) => n.joinRequestId === ritaRequest.id).length === 1, "…and one notification");
  check((await joinable(people.rita)) === "pending", "the switcher shows the request as sent");
  check((await joinFromSwitcher(people.rita.id, workspaceId)) === "pending", "…and asking there again changes nothing");
  await rejects(() => declineJoinRequest(people.member.id, workspaceId, ritaRequest.id), isAccessError, "members can't decline");
  await declineJoinRequest(people.owner.id, workspaceId, ritaRequest.id);
  check((await record(people.rita))?.status === "declined" && (await isMember(people.rita)) === null, "declining keeps them out");
  check(
    decisionMails.some((m) => m.to === people.rita.email && m.subject.includes(RUN) && !m.text.includes(`/w/${workspaceId}`)),
    "…and tells them, without a link in",
  );
  check((await joinable(people.rita)) === null, "someone declined can't ask again while the workspace takes no requests");
  check((await applyDomainPolicies(people.rita.id)).length === 0 && (await requestsOf(people.rita.email)).length === 0, "…nor by signing in");

  // Requests from the allowed domains
  await settings({ joinRequests: "allowed_domains" });
  check((await joinable(people.rita)) === "request", "with requests from the domains, someone declined may ask again");
  check((await joinable(people.ursula)) === "request", "…and so may an unverified address");
  check((await joinable(people.sub)) === "request", "…and someone an owner removed");
  check((await joinable(people.outsider)) === null, "…but not other domains");
  check((await joinFromSwitcher(people.ursula.id, workspaceId)) === "requested", "asking from the switcher files a request");
  check((await record(people.ursula))?.source === "switcher", "…from the switcher");
  check((await joinFromSwitcher(people.ursula.id, workspaceId)) === "pending", "…once");
  const [ursulaRequest] = await requestsOf(people.ursula.email);
  // The request remembers the asker's language; the decision email uses it.
  await db.update(workspaceJoinRequest).set({ locale: "tr" }).where(eq(workspaceJoinRequest.id, ursulaRequest.id));
  await approveJoinRequest(people.owner2.id, workspaceId, ursulaRequest.id);
  check((await isMember(people.ursula)) === "member" && (await record(people.ursula))?.status === "accepted", "approving lets them in as a member");
  check((await inviterOf(people.ursula)) === people.owner2.id, "…invited by the owner who approved", await inviterOf(people.ursula));
  const ursulaMail = decisionMails.find((m) => m.to === people.ursula.email);
  check(ursulaMail?.subject.includes("katıldınız") && ursulaMail.text.includes(`/w/${workspaceId}`), "…and emails them in their language, with a link in", ursulaMail);
  check((await requestNotifications(people.owner.id)).every((n) => n.joinRequestId !== ursulaRequest.id), "…and clears the other owners' inboxes");
  check((await joinFromSwitcher(people.ursula.id, workspaceId)) === "joined", "the switcher treats a member as joined");

  // Owners' preferences and inbox
  await setNotificationPreference(people.owner2.id, "join_request", "email", false);
  check((await joinFromSwitcher(people.rita.id, workspaceId)) === "requested", "someone declined asks again");
  const mailsBefore = ownerMails.length;
  await flushShareEmails();
  const newMails = ownerMails.slice(mailsBefore);
  check(newMails.some((m) => m.to === people.owner.email && m.subject.includes(people.rita.id)), "owners get an email about a join request");
  check(!newMails.some((m) => m.to === people.owner2.email), "…unless they turned those emails off");
  check((await listInbox(people.owner2.id, workspaceId)).some((n) => n.kind === "join_request"), "…it stays in their inbox");
  await setMemberRole(people.owner.id, workspaceId, people.owner2.id, "member");
  check(!(await listInbox(people.owner2.id, workspaceId)).some((n) => n.kind === "join_request"), "an owner made member no longer sees join requests");
  await setMemberRole(people.owner.id, workspaceId, people.owner2.id, "owner");

  // Someone joining another way settles their request
  const [ritaAgain] = await requestsOf(people.rita.email);
  await addMember(people.owner.id, workspaceId, people.rita.email, "member");
  check((await record(people.rita))?.status === "accepted" && (await requestsOf(people.rita.email)).length === 0, "an owner adding someone settles their request");
  check((await inviterOf(people.rita)) === people.owner.id, "…and the owner who added them invited them");
  check((await requestNotifications(people.owner.id)).every((n) => n.joinRequestId !== ritaAgain.id), "…and clears it from the inbox");

  // The join link
  await setJoinLink(people.owner.id, workspaceId, "enable");
  const [{ token }] = await db.select({ token: workspace.inviteLinkToken }).from(workspace).where(eq(workspace.id, workspaceId));
  check(!!token, "the join link is on");
  check((await joinLinkAccess(token!, people.outsider.id, people.outsider.email)) === "join", "the join link admits anyone while it doesn't ask");
  check((await joinWithLink(token!, people.outsider.id, people.outsider.email)).status === "joined", "…and does");
  check((await inviterOf(people.outsider)) === null, "…with nobody as their inviter: the link invites nobody");
  await removeMember(people.owner.id, workspaceId, people.outsider.id);
  check((await joinWithLink(token!, people.outsider.id, people.outsider.email)).status === "joined", "…even someone removed before: the owners shared it");
  await removeMember(people.owner.id, workspaceId, people.outsider.id);

  // An invitation is taken up through the link only by a verified address: anyone can sign up with
  // someone else's address, unproven, and would get their invitation's role.
  const cfoEmail = `cfo@${RUN}.test`;
  await addMember(people.owner.id, workspaceId, cfoEmail, "owner");
  const squatter = person("squatter", cfoEmail, false);
  userIds.push(squatter.id);
  await db.insert(user).values({ id: squatter.id, name: squatter.id, email: cfoEmail, emailVerified: false });
  const invitationFor = async (email: string) =>
    (await db.select({ role: workspaceInvitation.role }).from(workspaceInvitation).where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, email))))[0] ?? null;
  check((await joinWithLink(token!, squatter.id, cfoEmail)).status === "joined" && (await isMember(squatter)) === "member", "an unverified address invited as owner joins through the link as a member only");
  check((await inviterOf(squatter)) === null, "…invited by nobody");
  check((await invitationFor(cfoEmail))?.role === "owner", "…and the invitation stays for whoever owns the address");
  await removeMember(people.owner.id, workspaceId, squatter.id);

  await settings({ joinRequests: "anyone_with_link" });
  check((await joinLinkAccess(token!, people.linker.id, people.linker.email)) === "request", "when the link asks, it offers a request");
  const linked = await joinWithLink(token!, people.linker.id, people.linker.email);
  check(linked.status === "requested" && (await isMember(people.linker)) === null, "…files one instead of joining", linked);
  check((await record(people.linker))?.source === "link", "…from the link");
  check((await joinWithLink(token!, people.linker.id, people.linker.email)).status === "pending", "opening it again finds the request waiting");
  check((await joinLinkAccess(token!, people.linker.id, people.linker.email)) === "pending", "…and the join page says so");
  check((await joinWithLink(token!, people.outsider.id, people.outsider.email)).status === "requested", "someone removed before asks through the link");

  const laterEmail = `later@${RUN}.test`;
  await addMember(people.owner.id, workspaceId, laterEmail, "guest");
  const later = person("later", laterEmail);
  userIds.push(later.id);
  await db.insert(user).values({ id: later.id, name: later.id, email: laterEmail, emailVerified: false });
  check((await joinLinkAccess(token!, later.id, laterEmail)) === "request", "an invited address nobody verified gets no invitation when the link asks");
  const unproven = await joinWithLink(token!, later.id, laterEmail);
  check(unproven.status === "requested" && (await isMember(later)) === null, "…it files a request instead", unproven);
  check((await invitationFor(laterEmail))?.role === "guest", "…and leaves the invitation alone");
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, later.id));
  check((await joinLinkAccess(token!, later.id, laterEmail)) === "join", "someone invited, with their address verified, still joins through the link");
  check((await joinWithLink(token!, later.id, laterEmail)).status === "joined" && (await isMember(later)) === "guest", "…with their invitation's role");
  check((await invitationFor(laterEmail)) === null, "…which is used up");
  check((await inviterOf(later)) === people.owner.id, "…and invited by whoever sent the invitation");

  await settings({ domainJoin: "join" });
  check((await joinWithLink(token!, people.vera.id, people.vera.email)).status === "joined", "a verified allowed domain still joins through the link");
  await settings({ domainJoin: "request" });
  await removeMember(people.vera.id, workspaceId, people.vera.id);
  check((await joinWithLink(token!, people.vera.id, people.vera.email)).status === "requested", "…unless its domain asks too");

  // Rate limits: requests after a decline count against the person
  let refusedAt = 0;
  for (let attempt = 0; attempt < 15 && !refusedAt; attempt++) {
    const [waiting] = await requestsOf(people.linker.email);
    if (waiting) await declineJoinRequest(people.owner.id, workspaceId, waiting.id);
    try {
      await joinWithLink(token!, people.linker.id, people.linker.email);
    } catch (error) {
      check(isCode("tooManyRequests")(error), "asking too often is refused as too many requests", String(error));
      refusedAt = attempt;
    }
  }
  // One request filed above, then nine more before the tenth in the hour is the last.
  check(refusedAt === 9, "…after ten requests in an hour", { refusedAt });

  // Leaving the workspace leaves no request behind to decide
  const pending = await listJoinRequests(people.owner.id, workspaceId);
  check(pending.every((r) => r.email !== people.linker.email), "the refused request wasn't filed", pending);

  console.log(`\n${passed} checks passed`);
} finally {
  setJoinRequestMailer(null);
  setShareMailer(null);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await db.$client.end();
}

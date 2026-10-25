/**
 * End-to-end check of four administration features against the database:
 * - a published page's link that expires (server/publication.ts): refused in the past and too far
 *   ahead, recorded in the audit log, and once past served nowhere (its link, the site, its files,
 *   duplicating), shown as expired to owners, and back when extended or cleared;
 * - inviting someone into a teamspace by email (teamspaces.ts inviteToTeamspace): people already in
 *   the workspace are added, guests refused, verified accounts added to the workspace and the
 *   teamspace at once, others invited with the teamspace (joined when they accept, as owner when
 *   asked), members' invitations waiting for an owner carry it through the approval, inviting
 *   again keeps it, and "Who can add members" applies;
 * - handing over what a removed member alone could manage to someone the owner picks (removeMember
 *   `heirId`), the count shown beforehand and recorded, refused for guests and the person removed;
 *   someone leaving hands it to the oldest owner;
 * - the audience of the page each page event is about (server/page-audience.ts): private, specific
 *   people, a teamspace, the whole workspace and the web, in the CSV and in what is streamed;
 * - a whole workspace as a ZIP of PDFs (server/export-pdf.ts): one per page following the tree,
 *   databases as tables, rows with a body only, no templates, export off and owners only.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/admin-extras-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { and, eq, inArray, sql } = await import("drizzle-orm");
const { unzipSync } = await import("fflate");
const { db } = await import("@/db");
const { auditEvent, pagePermission, pagePublication, teamspace, user, workspace, workspaceInvitation, workspaceJoinRequest, workspaceMember, workspaceSite } =
  await import("@/db/schema");
const { createTranslator } = await import("next-intl");
const { default: en } = await import("@/i18n/messages/en");
const { auditAudience, auditCsvRows, describeAuditEvent } = await import("@/lib/audit");
const { streamedAuditEvent } = await import("@/lib/audit-stream");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { AccessError } = await import("@/server/access");
const { auditEventsForExport } = await import("@/server/audit");
const { ExportError } = await import("@/server/export");
const { pdfArchive, planPdfExport } = await import("@/server/export-pdf");
const { approveJoinRequest, listJoinRequests } = await import("@/server/join-requests");
const ops = await import("@/server/operations");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const publication = await import("@/server/publication");
const site = await import("@/server/site");
const { createTeamspace, inviteToTeamspace, listTeamspaceMembers, setTeamspaceRole, TeamspaceError } = await import("@/server/teamspaces");
const workspaces = await import("@/server/workspaces");

type AuditTranslator = import("@/lib/audit").AuditTranslator;

const RUN = `adminx-${Date.now().toString(36)}`;
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

/** Equal as JSON, whatever the order of keys (jsonb keeps its own). */
function same(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, w]) => [k, sorted(w)]))
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
  verified: `${RUN}-verified`,
};
const userIds = Object.values(ids);
const { owner, alice, bob, carol, guest, outsider, verified } = ids;
const emailOf = (id: string) => `${id}@example.test`;
const workspaceId = `${RUN}-ws`;
const SLUG = `${RUN}`;
const t = createTranslator({ locale: "en", messages: en, namespace: "settings" }) as unknown as AuditTranslator;

/** The latest audit event of an action about a target. */
async function lastEvent(action: string, targetId?: string) {
  const [row] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, action), targetId ? eq(auditEvent.targetId, targetId) : undefined))
    .orderBy(sql`${auditEvent.createdAt} desc`)
    .limit(1);
  return row;
}

try {
  await db.insert(user).values(
    userIds.map((id) => ({ id, name: id, email: emailOf(id), emailVerified: id === verified })),
  );
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const ctx = { userId: owner, actor: { userId: owner } };

  // ── Audience of page events ─────────────────────────────────────────────────────────────────
  const secret = await createPage({ userId: owner }, { workspaceId, teamspaceId: null, title: "Owner notes" });
  const created = await lastEvent("page.created", secret.id);
  check((created?.details.audience as { kind?: string })?.kind === "private", "a new private page reads as private", created?.details);
  await setPagePermission(owner, secret.id, alice, "view");
  const shared = await lastEvent("page.permission_changed", secret.id);
  check(
    same(shared?.details.audience, { kind: "people", people: 2, groups: 0 }),
    "…shared with someone, as specific people (counted)",
    shared?.details,
  );
  await setPagePermission(owner, secret.id, null, "view");
  const everyone = await lastEvent("page.permission_changed", secret.id);
  check((everyone?.details.audience as { kind?: string })?.kind === "workspace", "…opened to everyone, as the whole workspace", everyone?.details);

  const closed = await createTeamspace(owner, workspaceId, { name: `${RUN} Sales`, access: "closed" });
  const salesPage = await createPage({ userId: owner }, { workspaceId, teamspaceId: closed.id, title: "Pipeline" });
  const inSales = await lastEvent("page.created", salesPage.id);
  check(
    same(inSales?.details.audience, { kind: "teamspace", teamspace: `${RUN} Sales` }),
    "a page of a closed teamspace names the teamspace",
    inSales?.details,
  );
  const generalPage = await createPage({ userId: owner }, { workspaceId, teamspaceId: general.id, title: "Handbook" });
  const inGeneral = await lastEvent("page.created", generalPage.id);
  check((inGeneral?.details.audience as { kind?: string })?.kind === "workspace", "a page of the teamspace everyone is in reads as the whole workspace", inGeneral?.details);

  // ── Link expiry ─────────────────────────────────────────────────────────────────────────────
  const home = await createPage({ userId: owner }, { workspaceId, teamspaceId: general.id, title: "Public home" });
  const child = await createPage({ userId: owner }, { workspaceId, parentId: home.id, title: "Public child" });
  const { token } = await publication.publishPage(owner, home.id);
  const published = await lastEvent("page.published", home.id);
  check((published?.details.audience as { kind?: string })?.kind === "web", "publishing is recorded with the web as audience", published?.details);
  check((await publication.getPublishedPage(token)) !== null, "a published page is served");

  const past = await failure(() => publication.updatePublication(owner, home.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  check(past instanceof publication.PublishError && past.code === "expiryPast", "an expiry in the past is refused", String(past));
  const far = await failure(() => publication.updatePublication(owner, home.id, { expiresAt: new Date(Date.now() + 11 * 366 * 864e5).toISOString() }));
  check(far instanceof publication.PublishError && far.code === "expiryTooFar", "…and one more than ten years ahead", String(far));
  const bad = await failure(() => publication.updatePublication(owner, home.id, { expiresAt: "soon" as string }));
  check(bad instanceof publication.PublishError, "…and one that isn't a time", String(bad));
  const notOwner = await failure(() => publication.updatePublication(guest, home.id, { expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  check(notOwner instanceof AccessError, "…and from someone who can't manage the page", String(notOwner));

  const tomorrow = new Date(Date.now() + 864e5);
  await publication.updatePublication(owner, home.id, { expiresAt: tomorrow.toISOString() });
  check((await publication.getPublication(owner, home.id))?.expiresAt?.getTime() === tomorrow.getTime(), "an expiry ahead is kept");
  const setEvent = await lastEvent("page.publication_expiry_changed", home.id);
  check(setEvent?.details.from === null && setEvent?.details.to === tomorrow.toISOString(), "…and recorded with before and after", setEvent?.details);
  check(
    /Set the web link of Public home to stop working on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(
      describeAuditEvent({ action: setEvent!.action, targetLabel: setEvent!.targetLabel, details: setEvent!.details }, t),
    ),
    "…which reads as such",
  );
  check((await publication.getPublishedPage(token, child.id)) !== null, "before it, the link and its subpages are served");
  check(await publication.anyPagePublished([child.id]), "…and the files of its pages");

  await site.saveSite(owner, workspaceId, { slug: SLUG, title: "Docs", homePageId: home.id });
  const liveSite = await site.loadSite(SLUG);
  check(liveSite?.homeId === home.id && (await site.getSitePage(liveSite!)) !== null, "…and the site lists and serves it");

  // Its time passes.
  await db.update(pagePublication).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pagePublication.pageId, home.id));
  check((await publication.getPublishedPage(token)) === null, "once expired, the link isn't served");
  check((await publication.getPublishedPage(token, child.id)) === null, "…nor its subpages");
  check(!(await publication.anyPagePublished([child.id, home.id])), "…nor the files they show");
  check((await site.servedPublication(token)) === null, "…nor duplicated from");
  const expiredSite = await site.loadSite(SLUG);
  check(expiredSite !== null && expiredSite.homeId === null && expiredSite.nav.length === 0, "…and the site no longer lists it", expiredSite?.nav);
  const homeRefused = await failure(() => site.saveSite(owner, workspaceId, { slug: SLUG, title: "Docs", homePageId: home.id }));
  check(homeRefused instanceof site.SiteError, "…nor takes it as its home page", String(homeRefused));
  const listed = (await publication.listWorkspacePublications(owner, workspaceId)).find((p) => p.pageId === home.id);
  check(listed?.expired === true && listed.url === null && listed.expiresAt !== null, "owners see it as expired, without a link", listed);
  const kept = await publication.getPublication(owner, home.id);
  check(kept?.token === token, "the publication itself stays, with its link");

  await publication.updatePublication(owner, home.id, { expiresAt: null });
  check((await publication.getPublishedPage(token)) !== null && (await site.loadSite(SLUG))?.homeId === home.id, "clearing the expiry brings it back everywhere");
  const cleared = await lastEvent("page.publication_expiry_changed", home.id);
  check(cleared?.details.to === null, "…recorded too", cleared?.details);
  await publication.updatePublication(owner, home.id, { expiresAt: tomorrow.toISOString() });
  check((await publication.getPublishedPage(token)) !== null, "extending it to a time ahead serves it again");

  // ── Audience in the CSV and the stream ──────────────────────────────────────────────────────
  const events = await auditEventsForExport(owner, workspaceId, { actor: null, category: null, from: null, to: null, page: 1 });
  const rows = auditCsvRows(events, t);
  const audienceColumn = rows[0].indexOf("audience");
  check(audienceColumn > 0, "the CSV has an audience column", rows[0]);
  const salesRow = rows.find((r) => r[5] === "page.created" && r[8] === "Pipeline");
  check(salesRow?.[audienceColumn] === `Teamspace ${RUN} Sales`, "…naming the teamspace", salesRow);
  const webEvent = events.find((e) => e.action === "page.published");
  check(auditAudience(webEvent!, t) === "Published to the web", "…and the web");
  const streamed = streamedAuditEvent(webEvent!);
  check(streamed.target?.audience?.kind === "web", "the streamed event carries it with its target", streamed.target);
  const memberEvent = events.find((e) => e.targetType !== "page");
  check(memberEvent === undefined || streamedAuditEvent(memberEvent).target?.audience === undefined, "…and only for pages");

  // ── Inviting into a teamspace by email ───────────────────────────────────────────────────────
  const notManager = await failure(() => inviteToTeamspace(alice, closed.id, "someone@example.test"));
  check(notManager instanceof AccessError || notManager instanceof TeamspaceError, "only those who manage the teamspace invite to it", String(notManager));
  const notEmail = await failure(() => inviteToTeamspace(owner, closed.id, "not an email"));
  check(notEmail instanceof TeamspaceError && notEmail.code === "invalidEmail", "a text that isn't an address is refused", String(notEmail));

  const bobAdded = await inviteToTeamspace(owner, closed.id, emailOf(bob).toUpperCase());
  check(bobAdded.kind === "added", "someone in the workspace is added at once", bobAdded);
  check((await listTeamspaceMembers(owner, closed.id)).some((p) => p.userId === bob), "…to the teamspace");
  const guestRefused = await failure(() => inviteToTeamspace(owner, closed.id, emailOf(guest)));
  check(guestRefused instanceof TeamspaceError && guestRefused.code === "notMember", "a guest can't be brought in", String(guestRefused));

  const verifiedAdded = await inviteToTeamspace(owner, closed.id, emailOf(verified));
  check(verifiedAdded.kind === "added", "an account with a verified address joins the workspace and the teamspace at once", verifiedAdded);
  const verifiedJoined = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, verified)));
  check(
    verifiedJoined[0]?.role === "member" && (await listTeamspaceMembers(owner, closed.id)).some((p) => p.userId === verified),
    "…as a member of both",
    verifiedJoined,
  );

  const newcomer = `${RUN}-new@example.test`;
  const invited = await inviteToTeamspace(owner, closed.id, newcomer, "owner");
  check(invited.kind === "invited" && invited.email === newcomer, "anyone else gets an invitation", invited);
  const [invitation] = await db.select().from(workspaceInvitation).where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, newcomer)));
  check(
    same(invitation?.teamspaces, [{ id: closed.id, role: "owner" }]) && invitation.role === "member",
    "…to the workspace as a member, carrying the teamspace and the role there",
    invitation,
  );
  // An owner invites them again from Settings > Members, without a teamspace: it stays.
  await workspaces.addMember(owner, workspaceId, newcomer, "member");
  const [again] = await db.select().from(workspaceInvitation).where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, newcomer)));
  check(
    (again.teamspaces as { id: string }[]).some((s) => s.id === closed.id),
    "inviting them again keeps the teamspace",
    again.teamspaces,
  );
  const newcomerId = `${RUN}-newcomer`;
  await db.insert(user).values({ id: newcomerId, name: "Newcomer", email: newcomer });
  userIds.push(newcomerId);
  await workspaces.acceptInvitation(again.token, newcomerId, newcomer);
  const afterAccept = (await listTeamspaceMembers(owner, closed.id)).find((p) => p.userId === newcomerId);
  check(afterAccept?.role === "owner", "accepting joins the workspace and the teamspace, as its owner", afterAccept);
  const joinedEvent = await lastEvent("teamspace.member_added", closed.id);
  check(joinedEvent?.details.via === "invitation" && joinedEvent.actorUserId === newcomerId, "…recorded as joined through the invitation", joinedEvent?.details);

  // Members' invitations wait for an owner: the request carries the teamspace through the approval.
  await workspaces.updateWorkspaceSettings(owner, workspaceId, { memberInvites: "members_with_approval" });
  await setTeamspaceRole(owner, closed.id, bob, "owner");
  const waiting = `${RUN}-waiting@example.test`;
  const requested = await inviteToTeamspace(bob, closed.id, waiting);
  check(requested.kind === "requested", "a member's invitation waits for an owner when the workspace says so", requested);
  const [request] = await db.select().from(workspaceJoinRequest).where(and(eq(workspaceJoinRequest.workspaceId, workspaceId), eq(workspaceJoinRequest.email, waiting)));
  check(same(request?.teamspaces, [{ id: closed.id, role: "member" }]), "…the request carrying the teamspace", request);
  const pending = (await listJoinRequests(owner, workspaceId)).find((r) => r.email === waiting);
  await approveJoinRequest(owner, workspaceId, pending!.id);
  const [approved] = await db.select().from(workspaceInvitation).where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, waiting)));
  check(
    same(approved?.teamspaces, [{ id: closed.id, role: "member" }]) && approved.invitedBy === bob,
    "approved, it becomes the member's invitation with the teamspace",
    approved,
  );
  await workspaces.updateWorkspaceSettings(owner, workspaceId, { memberInvites: "owners" });
  const ownersOnly = await failure(() => inviteToTeamspace(bob, closed.id, `${RUN}-nope@example.test`));
  check(ownersOnly instanceof AccessError, "while only owners add members, a teamspace owner who isn't one can't invite", String(ownersOnly));

  // ── Handing over a removed member's pages ────────────────────────────────────────────────────
  const alicePage = await createPage({ userId: alice }, { workspaceId, teamspaceId: null, title: "Alice's plan" });
  await setPagePermission(alice, alicePage.id, carol, "view");
  const count = await workspaces.pagesOnlyTheyManage(owner, workspaceId, alice);
  check(count === 1, "the dialog learns how many pages only they could manage", count);
  check((await failure(() => workspaces.pagesOnlyTheyManage(alice, workspaceId, bob))) instanceof AccessError, "…owners only");
  const toGuest = await failure(() => workspaces.removeMember(owner, workspaceId, alice, { heirId: guest }));
  check(toGuest instanceof workspaces.WorkspaceError && toGuest.code === "heirInvalid", "a guest can't take them over", String(toGuest));
  const toThemselves = await failure(() => workspaces.removeMember(owner, workspaceId, alice, { heirId: alice }));
  check(toThemselves instanceof workspaces.WorkspaceError && toThemselves.code === "heirInvalid", "…nor the person removed", String(toThemselves));
  const toOutsider = await failure(() => workspaces.removeMember(owner, workspaceId, alice, { heirId: outsider }));
  check(toOutsider instanceof workspaces.WorkspaceError && toOutsider.code === "heirInvalid", "…nor someone outside the workspace", String(toOutsider));
  check((await db.select().from(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, alice)))).length === 1, "…and nothing changed");

  await workspaces.removeMember(owner, workspaceId, alice, { heirId: carol });
  const [heirEntry] = await db.select().from(pagePermission).where(and(eq(pagePermission.pageId, alicePage.id), eq(pagePermission.userId, carol)));
  check(heirEntry?.level === "full", "the member picked takes over the pages only they could manage", heirEntry);
  const [ownerEntry] = await db.select().from(pagePermission).where(and(eq(pagePermission.pageId, alicePage.id), eq(pagePermission.userId, owner)));
  check(!ownerEntry, "…not the owner who removed them");
  const handed = await lastEvent("member.content_handed_over", alice);
  check(handed?.details.count === 1 && handed.details.subjectId === carol && handed.actorUserId === owner, "…recorded with who received how many", handed?.details);
  check(
    describeAuditEvent({ action: handed!.action, targetLabel: handed!.targetLabel, details: handed!.details }, t) ===
      `Handed 1 page that only ${alice} could manage over to ${carol}`,
    "…which reads as such",
  );

  const carolPage = await createPage({ userId: carol }, { workspaceId, teamspaceId: null, title: "Carol's draft" });
  await workspaces.removeMember(carol, workspaceId, carol);
  const [oldest] = await db.select().from(pagePermission).where(and(eq(pagePermission.pageId, carolPage.id), eq(pagePermission.userId, owner)));
  check(oldest?.level === "full", "someone leaving hands theirs to the oldest owner, as before");
  const left = await lastEvent("member.content_handed_over", carol);
  check(left?.actorUserId === carol && left.details.subjectId === owner, "…recorded too", left?.details);

  // ── The workspace as a ZIP of PDFs ───────────────────────────────────────────────────────────
  const tasks = await createPage({ userId: owner }, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tasks" });
  await ops.createDatabaseRow(ctx, { database_id: tasks.id, title: "Write the brief", markdown: "The brief says what we build." });
  await ops.createDatabaseRow(ctx, { database_id: tasks.id, title: "Empty row" });
  const plan = await planPdfExport(owner, workspaceId);
  const paths = plan.pdfs.map((p) => p.path);
  check(paths.includes("Tasks.pdf") && paths.includes("Tasks/Write the brief.pdf"), "a database is a PDF, and a row with a body one in its folder", paths);
  check(!paths.some((p) => p.includes("Empty row")), "…a row without one isn't", paths);
  check(paths.includes("Public home.pdf") && paths.includes("Public home/Public child.pdf"), "subpages sit in their page's folder", paths);
  check(paths.every((p) => p.endsWith(".pdf")) && plan.files.length === 0, "only PDFs, no uploaded files", plan.files.length);
  const chunks: Uint8Array[] = [];
  const reader = pdfArchive(owner, plan).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const zip = unzipSync(Buffer.concat(chunks));
  check(
    Object.keys(zip).sort().join("|") === [...paths].sort().join("|") &&
      Object.values(zip).every((bytes) => Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-"),
    "the archive holds each of them as a PDF",
    Object.keys(zip),
  );
  check((await lastEvent("export.page")) === undefined, "…without one audit event per page");
  check((await failure(() => planPdfExport(bob, workspaceId))) instanceof AccessError, "only owners export the workspace");
  await workspaces.updateWorkspaceSettings(owner, workspaceId, { export: false });
  const off = await failure(() => planPdfExport(owner, workspaceId));
  check(off instanceof ExportError && off.code === "disabled", "not while export is turned off", String(off));

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspaceSite).where(eq(workspaceSite.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

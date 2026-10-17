/**
 * End-to-end check of Settings > Guests against the database: who may see the list, which pages a
 * guest is listed with (only their own entries, not the subpages those open, not entries that take
 * access away, pages in the trash marked), what a viewer who can't see a page gets of it (a
 * count, never its title or id), who invited whom (as the membership records it, else who shared
 * first), pending page invitations, and the actions the tab offers (taking back page access and
 * page invitations, making a guest a member, removing a guest, withdrawing an invitation) with who
 * may do each. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/guests-e2e.ts
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
const { pageInvitation, user, workspace, workspaceInvitation, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { archivePage, createPage } = await import("@/server/pages");
const { listPagePermissions, removePageInvitation, removePagePermission, setPageGroupPermission, setPagePermission, sharePageByEmail } = await import(
  "@/server/permissions"
);
const { canInviteGuests, removeMember, revokeInvitation, setMemberRole, updateWorkspaceSettings } = await import(
  "@/server/workspaces"
);
const { listGuests } = await import("@/server/guests");
const { createGroup } = await import("@/server/groups");
const { guestsCsvRows } = await import("@/lib/guests-csv");
const { toCsv } = await import("@/lib/csv");

const RUN = `guests-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectLostAccess() {},
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

const isAccessError = (error: unknown) => error instanceof AccessError;

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  gina: `${RUN}-gina`,
  gus: `${RUN}-gus`,
  gil: `${RUN}-gil`,
  outsider: `${RUN}-outsider`,
};
const emailOf = (id: string) => `${id}@example.test`;
const newcomer = emailOf(`${RUN}-newcomer`);
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const { owner, alice, gina, gus, gil, outsider } = ids;

/** Who the membership says brought them in (`workspace_member.invited_by`). */
async function inviterOf(userId: string) {
  const [row] = await db
    .select({ invitedBy: workspaceMember.invitedBy })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
  return row?.invitedBy ?? null;
}

async function guestsFor(viewer: string) {
  const guests = await listGuests(viewer, workspaceId);
  return { guests, of: (key: string) => guests.find((g) => g.userId === key || g.email === key) };
}

try {
  // Verified addresses: sharing by email adds only such an account (see access-e2e for one that isn't).
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: emailOf(id), emailVerified: true })));
  // The workspace gets its General teamspace, where the pages below land, from a trigger.
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: gina, role: "guest" },
  ]);

  // R ─ C ─ G, and X that only the owner sees, S, and T that goes to the trash.
  const make = (title: string, parentId?: string) => createPage({ userId: owner }, { workspaceId, title: `${RUN} ${title}`, parentId });
  const R = (await make("R")).id;
  const C = (await make("C", R)).id;
  const G = (await make("G", C)).id;
  const X = (await make("X")).id;
  const S = (await make("S")).id;
  const T = (await make("T")).id;
  await setPagePermission(owner, X, owner, "full");
  await setPagePermission(owner, X, null, "none");

  // Gina: the owner shares R (so she sees C and G through it), Alice raises C, G is closed to her.
  check((await sharePageByEmail(owner, R, emailOf(gina), "view")).kind === "shared", "setup: R shared with Gina");
  await setPagePermission(alice, C, gina, "edit");
  await setPagePermission(owner, G, gina, "none");
  await setPagePermission(owner, X, gina, "view");
  await setPagePermission(owner, T, gina, "comment");
  await archivePage(owner, T);
  // Her own page, which nobody else sees.
  await updateWorkspaceSettings(owner, workspaceId, { guestPrivatePages: true });
  const ginas = (await createPage({ userId: gina }, { workspaceId, title: `${RUN} gina's own` })).id;
  // Gus has an account outside the workspace and joins as a guest when a page is shared with him.
  check((await sharePageByEmail(owner, S, emailOf(gus), "view")).kind === "added", "setup: Gus joins as a guest");
  // The newcomer has no account: S and X wait for them.
  check((await sharePageByEmail(owner, S, newcomer, "edit")).kind === "invited", "setup: the newcomer is invited");
  await sharePageByEmail(owner, X, newcomer, "view");

  // ── Who may see the list ───────────────────────────────────────────────────────────────────
  check(await canInviteGuests(owner, workspaceId), "owners manage guests");
  check(!(await canInviteGuests(alice, workspaceId)), "members don't, while only owners may invite guests");
  await rejects(() => listGuests(alice, workspaceId), isAccessError, "…and can't list them");
  await rejects(() => listGuests(gina, workspaceId), isAccessError, "guests can't list the guests");
  await rejects(() => listGuests(outsider, workspaceId), isAccessError, "nor can someone outside the workspace");
  await updateWorkspaceSettings(owner, workspaceId, { guestInvites: "members" });
  check(await canInviteGuests(alice, workspaceId), "members manage guests once they may invite them");
  await rejects(() => listGuests(gina, workspaceId), isAccessError, "guests still can't list the guests");

  // ── The owner's view ───────────────────────────────────────────────────────────────────────
  {
    const { guests, of } = await guestsFor(owner);
    check(
      guests.map((g) => g.email).sort().join() === [emailOf(gina), emailOf(gus), newcomer].sort().join(),
      "guests and invited guests are listed, owners and members aren't",
      guests.map((g) => g.email),
    );
    const g = of(gina)!;
    const listed = g.pages.map((p) => p.pageId);
    check(new Set(listed).size === listed.length, "no page is listed twice");
    check(listed.join() === [C, R, X, T].join(), "only her own entries: R, C and X, then T in the trash", g.pages);
    check(!listed.includes(G), "a subpage she sees through an entry above it isn't listed, nor one closed to her");
    const byId = new Map(g.pages.map((p) => [p.pageId, p]));
    check(byId.get(R)!.level === "view" && byId.get(C)!.level === "edit", "each with its own level");
    check(byId.get(R)!.by?.id === owner && byId.get(C)!.by?.id === alice, "and who shared it");
    check(byId.get(T)!.inTrash && !byId.get(R)!.inTrash, "pages in the trash are marked");
    check(g.pages.every((p) => p.canManage), "the owner may take back what they have full access to");
    check(g.hiddenPages === 1, "her own page is only counted for the owner", g.hiddenPages);
    check(!JSON.stringify(guests).includes(ginas) && !JSON.stringify(guests).includes("gina's own"), "…without its id or title");
    check(g.invitedBy?.id === owner, "the owner, who shared first, invited Gina", g.invitedBy);
    check(of(gus)!.invitedBy?.id === owner && of(gus)!.pages.map((p) => p.pageId).join() === S, "Gus: invited by the owner, S");
    const n = of(newcomer)!;
    check(n.userId === null && n.invitationId !== null && n.invitedBy?.id === owner, "the newcomer is pending, with the invitation for owners");
    check(n.invitations.map((p) => [p.pageId, p.level].join(":")).sort().join() === [`${S}:edit`, `${X}:view`].sort().join(), "…and the pages waiting for them");
  }

  // ── A member's view ────────────────────────────────────────────────────────────────────────
  {
    const { guests, of } = await guestsFor(alice);
    const g = of(gina)!;
    check(g.pages.map((p) => p.pageId).join() === [C, R, T].join(), "a member sees Gina's pages they can see", g.pages);
    check(g.hiddenPages === 2, "and a count of the others (X, her own page)", g.hiddenPages);
    const text = JSON.stringify(guests);
    check(!text.includes(X) && !text.includes(`${RUN} X`), "X appears nowhere in a member's list, not even as an id");
    const n = of(newcomer)!;
    check(n.invitations.map((p) => p.pageId).join() === S && n.hiddenInvitations === 1, "a member sees the invitation to S, and X counted");
    check(n.invitationId === null, "members don't get the workspace invitation");
    const csv = toCsv(guestsCsvRows(guests, (id) => `/p/${id}`));
    check(!csv.includes(X) && !csv.includes(`${RUN} X`) && csv.includes(`${RUN} R`), "the CSV has what the list has, and no more");
  }

  // ── The share panel ────────────────────────────────────────────────────────────────────────
  // P is the owner's alone but for Alice and a group; its subpage PS is shared with Gina.
  const P = (await make("P private")).id;
  await setPagePermission(owner, P, owner, "full");
  await setPagePermission(owner, P, null, "none");
  await setPagePermission(owner, P, alice, "view");
  const finance = await createGroup(owner, workspaceId, `${RUN} Finance`, [alice]);
  await setPageGroupPermission(owner, P, finance.id, "view");
  const PS = (await make("PS", P)).id;
  await setPagePermission(owner, PS, gina, "view");
  {
    const panel = await listPagePermissions(gina, PS);
    const text = JSON.stringify(panel);
    const ownerEntry = panel.entries.find((e) => e.userId === owner);
    check(ownerEntry?.inherited && ownerEntry.sourcePageId === null && ownerEntry.sourceTitle === null, "a guest sees an entry inherited from a page above they can't open, without that page", ownerEntry);
    check(!text.includes(P) && !text.includes(`${RUN} P private`), "…whose id and title appear nowhere in what they get");
    check(panel.entries.every((e) => e.userId === gina || e.email === null), "a guest gets no one's email", panel.entries);
    check(panel.entries.find((e) => e.userId === gina)?.email === emailOf(gina), "…but their own");
    const group = panel.groups.find((g) => g.groupId === finance.id);
    check(group?.name === null && group.memberCount === null && group.level === "view", "…and learns that a group has access, not its name or size", group);
  }
  {
    const panel = await listPagePermissions(alice, PS);
    check(panel.entries.find((e) => e.userId === owner)?.sourceTitle === `${RUN} P private`, "a member who can open the page above sees it named");
    check(panel.entries.find((e) => e.userId === gina)?.email === emailOf(gina), "…and the people's emails");
    check(panel.groups.find((g) => g.groupId === finance.id)?.name === `${RUN} Finance`, "…and the group");
  }
  const Q = (await make("Q closed")).id;
  await setPagePermission(owner, Q, owner, "full");
  await setPagePermission(owner, Q, null, "none");
  const QS = (await make("QS", Q)).id;
  await setPagePermission(owner, QS, alice, "view");
  {
    const panel = await listPagePermissions(alice, QS);
    const ownerEntry = panel.entries.find((e) => e.userId === owner);
    check(ownerEntry?.sourceTitle === null && ownerEntry.sourcePageId === null, "a member doesn't learn the title of a page above they can't open either", ownerEntry);
    check(ownerEntry?.email === emailOf(owner), "…but sees emails, as members do");
    check((await listPagePermissions(owner, QS)).entries.find((e) => e.userId === owner)?.sourceTitle === `${RUN} Q closed`, "the owner sees it named");
  }

  // ── Who invited them ───────────────────────────────────────────────────────────────────────
  // Gina was put in the workspace directly, so her membership names nobody and the list falls back
  // to who shared first (checked above). Sharing a page with Gus brought him in, which is recorded.
  check((await inviterOf(gina)) === null && (await inviterOf(gus)) === owner, "the membership records who brought a guest in");
  // Alice brings Gil in by sharing S; then her entry goes and the owner shares R with him. The
  // oldest entry by someone else is now the owner's, but Alice invited him.
  check((await sharePageByEmail(alice, S, emailOf(gil), "view")).kind === "added", "setup: Alice brings Gil in by sharing S");
  check((await inviterOf(gil)) === alice, "…and is recorded as his inviter");
  await removePagePermission(alice, S, gil);
  await setPagePermission(owner, R, gil, "view");
  {
    const g = (await guestsFor(owner)).of(gil)!;
    check(g.pages.map((p) => p.pageId).join() === R && g.pages[0].by?.id === owner, "setup: Gil's only entry is now the owner's", g.pages);
    check(g.invitedBy?.id === alice && g.invitedBy.name === alice, "the list shows the stored inviter, not who shared first", g.invitedBy);
    check((await guestsFor(alice)).of(gil)?.invitedBy?.id === alice, "…for members too");
  }

  // ── Actions ────────────────────────────────────────────────────────────────────────────────
  await removePagePermission(alice, C, gina);
  check(!(await guestsFor(owner)).of(gina)!.pages.some((p) => p.pageId === C), "a member takes back an entry on a page they manage");
  check((await resolvePageAccess(gina, C)).level === "view", "…and she sees C through R again");
  await rejects(() => removePagePermission(alice, X, gina), isAccessError, "a member can't take back access on a page they can't manage");
  await removePagePermission(owner, T, gina);
  check(!(await guestsFor(owner)).of(gina)!.pages.some((p) => p.pageId === T), "an entry on a page in the trash can be taken back too");
  await rejects(() => setMemberRole(alice, workspaceId, gina, "member"), isAccessError, "a member can't make a guest a member");
  await rejects(() => removeMember(alice, workspaceId, gina), isAccessError, "a member can't remove a guest");
  await rejects(() => removePagePermission(gina, R, gina), isAccessError, "a guest can't take back their own access to a page");

  await setMemberRole(owner, workspaceId, gus, "member");
  check(!(await guestsFor(owner)).of(gus), "a guest made a member leaves the list");
  const [gusRole] = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, gus)));
  check(gusRole?.role === "member", "…as a member");

  await removeMember(owner, workspaceId, gina);
  check(!(await guestsFor(owner)).of(gina), "a removed guest leaves the list");
  check((await resolvePageAccess(gina, R)).level === "none", "…and loses access to what was shared with them");
  check((await resolvePageAccess(owner, ginas)).level === "full", "…while their own page passes to the owner who removed them");

  await removePageInvitation(alice, S, newcomer);
  check(!(await guestsFor(alice)).of(newcomer), "a member no longer sees an invited guest once nothing they can see waits for them");
  const pending = (await guestsFor(owner)).of(newcomer)!;
  check(pending.invitations.map((p) => p.pageId).join() === X, "the owner still does, with X waiting");
  await revokeInvitation(owner, workspaceId, pending.invitationId!);
  check(!(await guestsFor(owner)).of(newcomer), "withdrawing the invitation takes them off the list");
  const left = await db.select({ id: pageInvitation.id }).from(pageInvitation).where(eq(pageInvitation.workspaceId, workspaceId));
  const invites = await db
    .select({ id: workspaceInvitation.id })
    .from(workspaceInvitation)
    .where(eq(workspaceInvitation.workspaceId, workspaceId));
  check(!left.length && !invites.length, "…with the pages that waited for them");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

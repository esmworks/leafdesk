/**
 * End-to-end check of a teamspace's member level ("what members get on its pages") against the
 * database: at the default (full access) nothing changes; lowered to "can edit", a plain member
 * gets edit where a page says nothing, while the teamspace's owners and the workspace's owners keep
 * full access and a page's own entry for everyone still decides; members who haven't joined an
 * open teamspace never get more than its members; whoever adds or moves a page to its top keeps
 * full access; property access rules now hold for the members; the Share panel and the property
 * access dialog say so; only workspace owners change it in a default teamspace; a private
 * teamspace stays out of a workspace owner's reach; MCP shows it; the change is in the audit log.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/teamspace-member-access-e2e.ts
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
const { auditEvent, page, pagePermission, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const databases = await import("@/server/databases");
const { createPage, movePage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { listPagePermissions, setPagePermission } = await import("@/server/permissions");
const { getPropertyAccessSettings, setPropertyAccess } = await import("@/server/property-access");
const { pageAccessOf } = await import("@/server/access");
const ops = await import("@/server/operations");
const { addTeamspaceMembers, createTeamspace, setTeamspaceRole, TeamspaceError, updateTeamspace } = await import("@/server/teamspaces");

const RUN = `tsaccess-e2e-${Date.now().toString(36)}`;

const disconnected: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
  async disconnectTeamspace(teamspaceId: string) {
    disconnected.push(teamspaceId);
  },
  async disconnectLostAccess() {},
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

async function failure(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => null,
    (error: unknown) => error,
  );
}

// owner: workspace owner, the teamspace's creator (so its owner); boss: another workspace owner,
// a plain member of the teamspace; lead: made an owner of the teamspace; member: a plain member;
// outsider: in the workspace, not in the (open) teamspace.
const ids = { owner: `${RUN}-owner`, boss: `${RUN}-boss`, lead: `${RUN}-lead`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const workspaceId = `${RUN}-ws`;
const level = async (userId: string, pageId: string) => (await pageAccessOf(userId, pageId))?.level;

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.boss, role: "owner" },
    ...[ids.lead, ids.member, ids.outsider].map((userId) => ({ workspaceId, userId, role: "member" as const })),
  ]);

  const ts = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Team`, access: "open" });
  await addTeamspaceMembers(ids.owner, ts.id, [ids.boss, ids.lead, ids.member]);
  await setTeamspaceRole(ids.owner, ts.id, ids.lead, "owner");
  check(ts.memberLevel === "full", "a new teamspace gives its members full access by default");

  const staff = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: ts.id, kind: "database", title: "Staff" });
  const salary = await databases.addProperty(ids.owner, staff.id, { name: "Salary", type: "number" });
  const bob = await createPage({ userId: ids.owner }, { workspaceId, parentId: staff.id, title: "Bob", properties: { Salary: 654321 } });
  const early = await createPage({ userId: ids.member }, { workspaceId, teamspaceId: ts.id, title: "Early" });

  // At full access nothing changes: members run the pages, and nothing is written for it.
  check((await level(ids.member, staff.id)) === "full", "at full access, a member has full access to the teamspace's pages");
  check((await level(ids.outsider, staff.id)) === "comment", "…and someone who hasn't joined the open teamspace can comment");
  const earlyEntries = await db.select().from(pagePermission).where(eq(pagePermission.pageId, early.id));
  check(earlyEntries.length === 0, "a page added at full access gets no entry of its own", earlyEntries);

  await setPropertyAccess(ids.owner, salary.id, { everyone: "none", exceptions: [] });
  const seenBefore = await databases.getDatabaseSnapshot(ids.member, staff.id);
  check(seenBefore.rows.find((r) => r.id === bob.id)?.properties[salary.id] === 654321, "with full access, a property rule doesn't hold the member");
  const settingsBefore = await getPropertyAccessSettings(ids.owner, salary.id);
  check(settingsBefore.fullAccess.count === 3, "the property access dialog counts the others with full access", settingsBefore.fullAccess);

  // Only workspace owners change what everyone gets in a default teamspace.
  const everyoneTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} All`, access: "default" });
  await setTeamspaceRole(ids.owner, everyoneTs.id, ids.lead, "owner");
  const refused = await failure(updateTeamspace(ids.lead, everyoneTs.id, { memberLevel: "edit" }));
  check(refused instanceof TeamspaceError && refused.code === "ownersOnly", "a teamspace owner can't change what everyone gets in a default teamspace", String(refused));
  const bad = await failure(updateTeamspace(ids.owner, ts.id, { memberLevel: "none" as never }));
  check(bad instanceof TeamspaceError && bad.code === "invalidMemberLevel", "an unknown member level is refused", String(bad));

  // Lowered to "can edit".
  await updateTeamspace(ids.lead, ts.id, { memberLevel: "edit" });
  check(disconnected.includes(ts.id), "lowering it drops the open editors of the teamspace's pages");
  check((await level(ids.member, staff.id)) === "edit", "a plain member now gets edit");
  check((await level(ids.lead, staff.id)) === "full", "the teamspace's owner keeps full access");
  check((await level(ids.boss, staff.id)) === "full", "so does a workspace owner in it");
  check((await level(ids.member, bob.id)) === "edit", "rows follow their database");
  check((await level(ids.outsider, staff.id)) === "comment", "someone who hasn't joined still comments");
  check((await level(ids.member, early.id)) === "edit", "a page added before it was lowered has no entry to keep: edit");

  const seen = await databases.getDatabaseSnapshot(ids.member, staff.id);
  check(!seen.properties.some((p) => p.id === salary.id), "now the property rule holds the member");
  check(!JSON.stringify(seen).includes("654321"), "…and nothing of the hidden value reaches them");
  const settings = await getPropertyAccessSettings(ids.owner, salary.id);
  check(settings.fullAccess.count === 2 && settings.fullAccess.names.length === 2, "the dialog's count drops to the owners", settings.fullAccess);

  const share = await listPagePermissions(ids.owner, staff.id);
  check(share.everyone === "edit" && share.everyoneFromTeamspace, "the Share panel shows the teamspace's level for everyone", share.everyone);
  check(share.floors[ids.member] === "edit" && share.floors[ids.lead] === "full" && share.floors[ids.boss] === "full", "…and what each gets from it", share.floors);

  // Full access to a copy or a moved page is kept, never gained: a copy leaves out what the copier
  // can't see, and only someone with full access moves a page.
  const copy = await duplicatePage({ userId: ids.member }, staff.id);
  check((await level(ids.member, copy.id)) === "full", "a member who copies the database runs the copy");
  const copied = await databases.getDatabaseSnapshot(ids.member, copy.id);
  check(!JSON.stringify(copied).includes("654321"), "…but the copy has none of the values hidden from them", copied.properties);
  const leadPage = await createPage({ userId: ids.lead }, { workspaceId, teamspaceId: ts.id, title: "Lead's plan" });
  const nested = await createPage({ userId: ids.lead }, { workspaceId, parentId: leadPage.id, title: "Nested" });
  const moveUp = await failure(movePage(ids.member, nested.id, null, undefined, ts.id));
  check(moveUp !== null && (await level(ids.member, nested.id)) === "edit", "a member with edit can't move a page to the top to gain full access", String(moveUp));
  const otherTs = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Other`, access: "closed", memberLevel: "edit" });
  await addTeamspaceMembers(ids.owner, otherTs.id, [ids.member]);
  const moveAcross = await failure(movePage(ids.member, leadPage.id, null, undefined, otherTs.id));
  check(moveAcross !== null && (await level(ids.member, leadPage.id)) === "edit", "…nor move it to another teamspace and back", String(moveAcross));

  // A page's own entry for everyone still decides, for the owners too.
  await setPagePermission(ids.owner, staff.id, ids.owner, "full");
  await setPagePermission(ids.owner, staff.id, null, "view");
  check((await level(ids.member, staff.id)) === "view" && (await level(ids.lead, staff.id)) === "view", "a page's entry for everyone holds for owners and members alike");
  await setPagePermission(ids.owner, staff.id, null, "full");
  check((await level(ids.member, staff.id)) === "full", "…and can raise members above the teamspace's level");
  await db.delete(pagePermission).where(eq(pagePermission.pageId, staff.id));

  // Whoever adds a page at the top keeps running it.
  const mine = await createPage({ userId: ids.member }, { workspaceId, teamspaceId: ts.id, kind: "database", title: "Mine" });
  check((await level(ids.member, mine.id)) === "full", "a member who adds a page at the top gets full access to it");
  check((await level(ids.lead, mine.id)) === "full", "…and the teamspace's owners keep theirs");
  const byLead = await createPage({ userId: ids.lead }, { workspaceId, teamspaceId: ts.id, title: "Lead's" });
  const leadEntries = await db.select().from(pagePermission).where(eq(pagePermission.pageId, byLead.id));
  check(leadEntries.length === 0, "an owner's new page needs no entry", leadEntries);
  const sub = await createPage({ userId: ids.member }, { workspaceId, parentId: byLead.id, title: "Sub" });
  check((await level(ids.member, sub.id)) === "edit", "a subpage follows its parent");
  const draft = await createPage({ userId: ids.member }, { workspaceId, teamspaceId: null, title: "Draft" });
  await movePage(ids.member, draft.id, null, undefined, ts.id);
  check((await level(ids.member, draft.id)) === "full", "moving a private page to the top of the teamspace keeps full access");
  check((await level(ids.lead, draft.id)) === "full" && (await level(ids.outsider, draft.id)) === "comment", "…and gives it the teamspace's access for the others");

  // At "can view", those who haven't joined an open teamspace get no more than its members.
  await updateTeamspace(ids.owner, ts.id, { memberLevel: "view" });
  check((await level(ids.member, staff.id)) === "view" && (await level(ids.outsider, staff.id)) === "view", "at view, members and outsiders both view");

  // A private teamspace stays out of a workspace owner's reach.
  const hidden = await createTeamspace(ids.owner, workspaceId, { name: `${RUN} Hidden`, access: "private", memberLevel: "edit" });
  const secret = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: hidden.id, title: "Secret" });
  check((await level(ids.boss, secret.id)) === "none", "a workspace owner outside a private teamspace gets nothing");
  check((await level(ids.owner, secret.id)) === "full", "its creator runs it");

  // MCP and the audit log.
  const listed = await ops.listTeamspaces({ userId: ids.member, actor: { userId: ids.member } } as never, { workspace_id: workspaceId, include_archived: false });
  check(listed.teamspaces.find((t) => t.id === ts.id)?.member_access === "view", "list_teamspaces shows member_access", listed.teamspaces);
  const events = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "teamspace.updated")));
  check(events.some((e) => JSON.stringify(e.details).includes("memberLevel")), "the change is in the audit log", events);

  // Back to full: as before.
  await updateTeamspace(ids.owner, ts.id, { memberLevel: "full" });
  check((await level(ids.member, staff.id)) === "full", "back at full access, members run the pages again");

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(page).where(eq(page.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  process.exit();
}

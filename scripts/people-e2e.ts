/**
 * End-to-end check of the people directory and workspace analytics against the database: who may
 * open them (guests and outsiders never, analytics only owners), that nothing the viewer can't see
 * comes through them (private teamspaces, private pages and their titles, trashed pages, other
 * workspaces), and that the edit counts match a known set of page versions and last edits for each
 * period. Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/people-e2e.ts
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
const { page, pageSnapshot, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError } = await import("@/server/access");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { createGroup } = await import("@/server/groups");
const { addTeamspaceMembers, createTeamspace } = await import("@/server/teamspaces");
const { peopleDirectory } = await import("@/server/people");
const { workspaceAnalytics } = await import("@/server/analytics");
const { analyticsCsvRows } = await import("@/lib/analytics");
const { toCsv } = await import("@/lib/csv");

const RUN = `people-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
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
  bob: `${RUN}-bob`,
  carol: `${RUN}-carol`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;
const { owner, alice, bob, carol, guest, outsider } = ids;

const now = new Date();
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms: number) => new Date(now.getTime() - ms);

/** A page version by `userId` at `at`, as page history saves them. */
const version = (pageId: string, userId: string, at: Date, reason: "auto" | "manual" | "before_mcp_write" = "auto") => ({
  pageId,
  title: "",
  ydoc: new Uint8Array(),
  reason,
  createdBy: userId,
  createdAt: at,
});

/** Sets who last changed the page and when, as a save or a row edit would. */
const lastEdit = (pageId: string, userId: string, at: Date) =>
  db.update(page).set({ updatedBy: userId, updatedAt: at }).where(eq(page.id, pageId));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWs, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
    { workspaceId, userId: bob, role: "member" },
    { workspaceId, userId: carol, role: "member" },
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
    { workspaceId: otherWs, userId: alice, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id, name: teamspace.name }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));

  // Alice's private teamspace, with Bob in it: not Carol, not the owner.
  const secretSpace = await createTeamspace(alice, workspaceId, { name: `${RUN} secret space`, access: "private" });
  await addTeamspaceMembers(alice, secretSpace.id, [bob]);
  const openSpace = await createTeamspace(alice, workspaceId, { name: `${RUN} open space`, access: "open" });
  await createGroup(owner, workspaceId, `${RUN} design`, [alice]);

  const create = (userId: string, title: string, teamspaceId: string | null, ws = workspaceId) =>
    createPage({ userId }, { workspaceId: ws, title, teamspaceId });
  const shared = await create(alice, `${RUN} shared`, general.id);
  const alicePrivate = await create(alice, `${RUN} alice private`, null);
  const secretPage = await create(alice, `${RUN} secret page`, secretSpace.id);
  const carolPage = await create(carol, `${RUN} carol page`, general.id);
  const guestPage = await create(owner, `${RUN} guest page`, general.id);
  const trashed = await create(alice, `${RUN} trashed`, general.id);
  const elsewhere = await create(outsider, `${RUN} elsewhere`, null, otherWs);
  await setPagePermission(owner, guestPage.id, guest, "edit");
  await setPagePermission(outsider, elsewhere.id, alice, "edit");
  await archivePage(alice, trashed.id);

  // ── The known edits ───────────────────────────────────────────────────────────────────────────
  // shared: Alice 3 in the week (her last edit 5 minutes after one of them, so it is the same
  // edit), 1 at 20 days, 1 at 60 days; Bob 1 (and a version he saved by hand, which isn't an edit);
  // someone no longer in the workspace 1.
  // alicePrivate: Alice 2 versions, and a last edit 30 minutes after the newer one: 3.
  // secretPage: Bob 1 version and a last edit 5 days ago with no version near it: 2.
  // carolPage: only Carol's last edit, as a row's values would be: 1.
  // guestPage: the guest 1 version; the owner's last edit 40 days ago.
  // trashed: Alice 1. elsewhere (another workspace): Alice 1, never counted here.
  await db.insert(pageSnapshot).values([
    version(shared.id, alice, ago(1 * DAY)),
    version(shared.id, alice, ago(2 * DAY)),
    version(shared.id, alice, ago(3 * DAY)),
    version(shared.id, alice, ago(20 * DAY)),
    version(shared.id, alice, ago(60 * DAY)),
    version(shared.id, bob, ago(1 * DAY + 3 * MINUTE)),
    version(shared.id, bob, ago(1 * DAY + 4 * MINUTE), "manual"),
    version(shared.id, outsider, ago(1 * DAY + 5 * MINUTE)),
    version(alicePrivate.id, alice, ago(2 * DAY)),
    version(alicePrivate.id, alice, ago(4 * DAY)),
    version(secretPage.id, bob, ago(1 * DAY)),
    version(guestPage.id, guest, ago(1 * DAY), "before_mcp_write"),
    version(trashed.id, alice, ago(12 * 60 * MINUTE)),
    version(elsewhere.id, alice, ago(1 * DAY)),
  ]);
  await lastEdit(shared.id, alice, ago(1 * DAY - 5 * MINUTE));
  await lastEdit(alicePrivate.id, alice, ago(2 * DAY - 30 * MINUTE));
  await lastEdit(secretPage.id, bob, ago(5 * DAY));
  await lastEdit(carolPage.id, carol, ago(3 * DAY));
  await lastEdit(guestPage.id, owner, ago(40 * DAY));
  await lastEdit(trashed.id, alice, ago(12 * 60 * MINUTE - MINUTE));
  await lastEdit(elsewhere.id, alice, ago(1 * DAY));

  const hidden = [alicePrivate, secretPage].flatMap((p) => [p.id, p.title]);
  const leaks = (value: unknown, secrets: string[]) => {
    const text = JSON.stringify(value);
    return secrets.filter((s) => text.includes(s));
  };

  // ── Who may open them ─────────────────────────────────────────────────────────────────────────
  await rejects(() => peopleDirectory(guest, workspaceId, now), isAccessError, "guests can't open the people directory");
  await rejects(() => peopleDirectory(outsider, workspaceId, now), isAccessError, "…nor can people outside the workspace");
  await rejects(() => workspaceAnalytics(alice, workspaceId, 30, now), isAccessError, "members can't read analytics");
  await rejects(() => workspaceAnalytics(guest, workspaceId, 30, now), isAccessError, "…nor guests");
  await rejects(() => workspaceAnalytics(outsider, workspaceId, 30, now), isAccessError, "…nor another workspace's owner");

  // ── The directory, as Carol (outside the private teamspace) ───────────────────────────────────
  const asCarol = await peopleDirectory(carol, workspaceId, now);
  const card = (list: typeof asCarol, userId: string) => list.find((p) => p.userId === userId);
  check(
    asCarol.map((p) => p.userId).sort().join() === [owner, alice, bob, carol].sort().join(),
    "the directory lists the owners and members, not the guest",
    asCarol.map((p) => p.userId),
  );
  check(
    card(asCarol, alice)?.teamspaces.map((t) => t.name).sort().join() === [general.name, openSpace.name].sort().join(),
    "a card leaves out private teamspaces the viewer isn't in",
    card(asCarol, alice)?.teamspaces,
  );
  check(card(asCarol, alice)?.groups.map((g) => g.name).join() === `${RUN} design`, "…and shows the person's groups");
  check(
    card(asCarol, alice)?.recentPages.map((p) => p.id).join() === shared.id,
    "recent pages are only those the viewer can open (not a private page, not a trashed one)",
    card(asCarol, alice)?.recentPages,
  );
  check(
    card(asCarol, bob)?.recentPages.map((p) => p.id).join() === shared.id,
    "…nor a page of a private teamspace the viewer isn't in",
    card(asCarol, bob)?.recentPages,
  );
  check(card(asCarol, carol)?.recentPages.map((p) => p.id).join() === carolPage.id, "a change history doesn't version counts as recent");
  check(
    leaks(asCarol, [...hidden, secretSpace.id, secretSpace.name, trashed.id, elsewhere.id]).length === 0,
    "nothing of the private teamspace, private page, trashed page or other workspace is in Carol's directory",
    leaks(asCarol, [...hidden, secretSpace.id, secretSpace.name, trashed.id, elsewhere.id]),
  );

  // ── The directory, as Alice and Bob ───────────────────────────────────────────────────────────
  const asAlice = await peopleDirectory(alice, workspaceId, now);
  check(
    card(asAlice, bob)?.teamspaces.some((t) => t.id === secretSpace.id),
    "someone in the private teamspace sees it on the cards of others in it",
  );
  check(
    card(asAlice, bob)?.recentPages.map((p) => p.id).join() === [secretPage.id, shared.id].join(),
    "…and their pages there, newest first",
    card(asAlice, bob)?.recentPages,
  );
  check(
    card(asAlice, alice)?.recentPages.map((p) => p.id).join() === [shared.id, alicePrivate.id].join(),
    "people see their own private pages on their own card",
    card(asAlice, alice)?.recentPages,
  );
  const asBob = await peopleDirectory(bob, workspaceId, now);
  check(
    !card(asBob, alice)?.recentPages.some((p) => p.id === alicePrivate.id),
    "…but no one else sees them, even in the same teamspaces",
  );
  check(asAlice.every((p) => p.recentPages.length <= 3), "a card shows at most three recent pages");

  // ── Analytics: the counts ─────────────────────────────────────────────────────────────────────
  const week = await workspaceAnalytics(owner, workspaceId, 7, now);
  const person = (report: typeof week, userId: string) => report.people.find((p) => p.userId === userId);
  check(week.totalEdits === 13 && week.pagesEdited === 6, "7 days: 13 edits on 6 pages", { total: week.totalEdits, pages: week.pagesEdited });
  check(
    [alice, bob, carol, guest, owner].map((id) => `${person(week, id)?.edits}/${person(week, id)?.pages}`).join() === "7/3,3/2,1/1,1/1,0/0",
    "7 days: edits and pages per person",
    week.people.map((p) => ({ id: p.userId, edits: p.edits, pages: p.pages })),
  );
  check(week.activeMembers === 3 && week.memberCount === 4, "7 days: 3 of 4 members active (the guest is listed, not counted)", week);
  check(person(week, outsider) === undefined, "people outside the workspace aren't listed, though their edits count");
  check(week.people[0].userId === alice && week.people.at(-1)?.userId === owner, "people are listed by edits, most first");
  check(
    week.pages.map((p) => `${p.edits}/${p.editors}`).join() === "5/3,3/1,2/1,1/1,1/1,1/1",
    "7 days: the most edited pages with their edits and editors",
    week.pages,
  );
  check(
    person(week, alice)?.lastEditAt?.getTime() === ago(12 * 60 * MINUTE).getTime(),
    "a person's last edit is their newest",
    person(week, alice),
  );

  const month = await workspaceAnalytics(owner, workspaceId, 30, now);
  check(
    month.totalEdits === 14 && person(month, alice)?.edits === 8 && person(month, owner)?.edits === 0,
    "30 days: edits from 20 days ago count too",
    { total: month.totalEdits, alice: person(month, alice)?.edits },
  );
  const quarter = await workspaceAnalytics(owner, workspaceId, 90, now);
  check(
    quarter.totalEdits === 16 && person(quarter, alice)?.edits === 9 && person(quarter, owner)?.edits === 1,
    "90 days: and those from 40 and 60 days ago",
    { total: quarter.totalEdits, alice: person(quarter, alice)?.edits, owner: person(quarter, owner)?.edits },
  );
  check(quarter.activeMembers === 4 && quarter.pagesEdited === 6, "90 days: every member active, still 6 pages");

  // ── Analytics: nothing the owner can't open ───────────────────────────────────────────────────
  const top = week.pages;
  check(top[0].id === shared.id && top[0].title === shared.title, "pages the owner can open are named");
  const privateRows = top.filter((p) => p.id === null);
  check(
    privateRows.length === 2 && privateRows.every((p) => p.title === null && p.icon === null && p.kind === null),
    "a private page and a page of a private teamspace are counted but untitled",
    top,
  );
  check(leaks(week, hidden).length === 0, "no title or id of those pages is in the report", leaks(week, hidden));
  const csv = toCsv(analyticsCsvRows(week, "pages"));
  check(leaks(csv, hidden).length === 0 && csv.split("\r\n").filter((l) => l.includes(",yes,")).length === 2, "…nor in its CSV");
  check(leaks(quarter, [elsewhere.id, elsewhere.title]).length === 0, "another workspace's pages never appear");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await db.$client.end();
}

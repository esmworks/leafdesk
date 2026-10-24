/**
 * End-to-end check of page views and page analytics against the database: who gets recorded (owners
 * and members, not guests, agents, people outside or pages in the trash), that reopening a page
 * within the repeat window counts once, the person's and the owners' switches, who may open a
 * page's Analytics (people who may edit it, never guests), the workspace totals and most viewed
 * pages in Settings > Analytics, retention and cascades. Creates its own users and workspaces and
 * deletes them afterwards. Needs no server.
 *
 *   pnpm tsx scripts/page-analytics-e2e.ts
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
const { page, pageView, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError } = await import("@/server/access");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { createAgent } = await import("@/server/agents/manage");
const { workspaceAnalytics } = await import("@/server/analytics");
const { deleteOldPageViews, ownPageViews, pageAnalytics, recordPageView, setOwnPageViews } = await import("@/server/page-views");
const { analyticsCsvRows } = await import("@/lib/analytics");
const { VIEW_REPEAT_MS, viewDay } = await import("@/lib/page-views");

const RUN = `page-analytics-e2e-${Date.now().toString(36)}`;

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

async function rejects(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
  } catch (error) {
    check(error instanceof AccessError, label, String(error));
    return;
  }
  check(false, label, "did not throw");
}

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds: string[] = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWs = `${RUN}-ws2`;
const { owner, alice, bob, guest, outsider } = ids;

const now = new Date();
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(now.getTime() + ms);

const rowsOf = (pageId: string, userId?: string) =>
  db
    .select()
    .from(pageView)
    .where(and(eq(pageView.pageId, pageId), userId ? eq(pageView.userId, userId) : undefined));

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
    { workspaceId, userId: guest, role: "guest" },
    { workspaceId: otherWs, userId: outsider, role: "owner" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const create = (userId: string, title: string, teamspaceId: string | null) => createPage({ userId }, { workspaceId, title, teamspaceId });
  const shared = await create(owner, `${RUN} shared`, general.id);
  const quiet = await create(owner, `${RUN} quiet`, general.id);
  const alicePrivate = await create(alice, `${RUN} alice private`, null);
  const guestPage = await create(owner, `${RUN} guest page`, general.id);
  const trashed = await create(alice, `${RUN} trashed`, general.id);
  await setPagePermission(owner, guestPage.id, guest, "edit");
  await archivePage(alice, trashed.id);

  // ── Recording ────────────────────────────────────────────────────────────────────────────────
  check(await recordPageView(alice, shared.id, at(-3 * DAY)), "a member's view is recorded");
  check(!(await recordPageView(alice, shared.id, at(-3 * DAY + MINUTE))), "reopening within the repeat window doesn't count");
  check(await recordPageView(alice, shared.id, at(-3 * DAY + VIEW_REPEAT_MS + MINUTE)), "reopening after the repeat window counts again");
  let rows = await rowsOf(shared.id, alice);
  check(rows.length === 1 && rows[0].count === 2, "one row per page, person and day, with its count", rows);
  check(rows[0].day === viewDay(at(-3 * DAY)), "the row is the view's UTC day", rows[0].day);
  check(await recordPageView(alice, shared.id, at(-1 * DAY)), "another day is another row");
  check(await recordPageView(alice, shared.id, now), "and today");
  check(await recordPageView(owner, shared.id, at(-2 * DAY)), "owners are recorded");
  check(await recordPageView(bob, shared.id, at(-40 * DAY)), "a view outside the 30-day period is recorded too");
  check(await recordPageView(alice, alicePrivate.id, now), "a view of a private page is recorded");
  check((await rowsOf(shared.id)).length === 5, "five day rows for the shared page", await rowsOf(shared.id));

  check(!(await recordPageView(guest, guestPage.id, now)), "guests aren't recorded");
  check((await rowsOf(guestPage.id)).length === 0, "no row for the guest's view");
  check(!(await recordPageView(outsider, shared.id, now)), "people outside the workspace aren't recorded");
  check(!(await recordPageView(bob, alicePrivate.id, now)), "a page the person can't open isn't recorded");
  check(!(await recordPageView(alice, trashed.id, now)), "pages in the trash aren't recorded");
  check(!(await recordPageView(alice, `${RUN}-missing`, now)), "a page that doesn't exist isn't recorded");

  const agent = await createAgent(owner, workspaceId, { name: `${RUN} agent` });
  userIds.push(agent.userId);
  await setPagePermission(owner, shared.id, agent.userId, "view").catch(() => {});
  check(!(await recordPageView(agent.userId, shared.id, now)), "agents aren't recorded");
  check((await rowsOf(shared.id, agent.userId)).length === 0, "no row for the agent");

  // ── The person's own switch ──────────────────────────────────────────────────────────────────
  check((await ownPageViews(bob, workspaceId)).own === true, "people are recorded until they turn it off");
  await setOwnPageViews(bob, workspaceId, false);
  check((await ownPageViews(bob, workspaceId)).own === false, "the person's switch is saved");
  check(!(await recordPageView(bob, quiet.id, now)), "someone who turned it off isn't recorded");
  check((await rowsOf(quiet.id)).length === 0, "no row while they are off");
  await setOwnPageViews(bob, workspaceId, true);
  check(await recordPageView(bob, quiet.id, now), "turned back on, they are recorded again");
  await rejects(() => setOwnPageViews(guest, workspaceId, false), "guests have no switch of their own");
  await rejects(() => ownPageViews(guest, workspaceId), "nor see one");
  await rejects(() => setOwnPageViews(outsider, workspaceId, false), "people outside the workspace neither");

  // ── A page's Analytics ───────────────────────────────────────────────────────────────────────
  const week = await pageAnalytics(alice, shared.id, 7, now);
  check(week.recording, "the page's analytics know views are recorded");
  check(week.views === 5 && week.viewers === 2, "views and viewers of the period (Bob's older view left out)", week);
  check(week.daily.length === 7 && week.daily.reduce((sum, d) => sum + d.views, 0) === 5, "a day per period day, adding up to the views", week.daily);
  check(week.daily.at(-1)?.day === viewDay(now) && week.daily.at(-1)?.views === 1, "today is the last day", week.daily.at(-1));
  check(
    week.people.map((p) => p.userId).join() === [alice, owner].join() && week.people[0].views === 4,
    "viewers listed by views, most first",
    week.people,
  );
  check(week.editors.some((e) => e.userId === owner), "who edited it is listed (its creator)", week.editors);
  const quarter = await pageAnalytics(owner, shared.id, 90, now);
  check(quarter.views === 6 && quarter.viewers === 3 && quarter.daily.length === 90, "a longer period takes in the older view", quarter);

  await rejects(() => pageAnalytics(guest, guestPage.id, 30, now), "guests can't open a page's analytics, even with edit access");
  await rejects(() => pageAnalytics(outsider, shared.id, 30, now), "people outside the workspace can't");
  await rejects(() => pageAnalytics(owner, alicePrivate.id, 30, now), "nor anyone who can't open the page");
  await setPagePermission(alice, alicePrivate.id, bob, "view");
  await rejects(() => pageAnalytics(bob, alicePrivate.id, 30, now), "viewing isn't enough: it takes edit access");
  await setPagePermission(alice, alicePrivate.id, bob, "edit");
  const privateStats = await pageAnalytics(bob, alicePrivate.id, 30, now);
  check(privateStats.views === 1 && privateStats.people[0]?.userId === alice, "with edit access the analytics open", privateStats);

  // ── Settings > Analytics ─────────────────────────────────────────────────────────────────────
  const report = await workspaceAnalytics(owner, workspaceId, 30, now);
  check(report.recording && report.views !== null, "the workspace report has views while they are recorded");
  const views = report.views;
  check(views.total === 7 && views.viewers === 3 && views.pagesViewed === 3, "totals of the period", { ...views, people: undefined, pages: undefined });
  check(views.pages[0]?.id === shared.id && views.pages[0].views === 5 && views.pages[0].viewers === 2, "the most viewed page first", views.pages[0]);
  const hidden = views.pages.find((p) => p.id === null);
  check(hidden && hidden.views === 1 && hidden.title === null, "a page the owner can't open is counted but not named", views.pages);
  check(!views.people.some((p) => p.userId === guest), "guests aren't in the views per person");
  check(views.people[0]?.userId === alice && views.people[0].views === 5 && views.people[0].pages === 2, "views per person, most first", views.people);
  check(views.people.find((p) => p.userId === bob)?.views === 1, "a member's views in the period");
  const viewedCsv = analyticsCsvRows(report, "viewed");
  check(viewedCsv.length === 4 && viewedCsv.some((r) => r[1] === "yes" && r[0] === null), "the most viewed pages download, the private one untitled", viewedCsv);
  check(analyticsCsvRows(report, "viewers").length === 1 + views.people.length, "the views per person download");
  await rejects(() => workspaceAnalytics(alice, workspaceId, 30, now), "members can't read the workspace's analytics");

  // ── The owners' switch ───────────────────────────────────────────────────────────────────────
  await updateWorkspaceSettings(owner, workspaceId, { pageViews: false });
  check(!(await recordPageView(alice, quiet.id, at(MINUTE))), "with recording off nothing is recorded");
  check((await rowsOf(quiet.id, alice)).length === 0, "no row while it is off");
  check((await ownPageViews(alice, workspaceId)).workspace === false, "members see the workspace doesn't record views");
  const off = await workspaceAnalytics(owner, workspaceId, 30, now);
  check(!off.recording && off.views === null, "the workspace report shows edits only", { recording: off.recording, views: off.views });
  check(analyticsCsvRows(off, "viewed").length === 1, "and its views downloads are empty");
  const pageOff = await pageAnalytics(alice, shared.id, 30, now);
  check(!pageOff.recording && pageOff.views === 0 && pageOff.people.length === 0 && pageOff.daily.length === 0, "a page's analytics show edits only", pageOff);
  check(pageOff.editors.length > 0, "but still who edited it");
  await updateWorkspaceSettings(owner, workspaceId, { pageViews: true });
  check(await recordPageView(alice, quiet.id, at(MINUTE)), "turned back on, views are recorded again");

  // ── Retention and cascades ───────────────────────────────────────────────────────────────────
  await db.insert(pageView).values({ pageId: quiet.id, userId: bob, day: viewDay(at(-400 * DAY)), count: 3, lastViewedAt: at(-400 * DAY) });
  await db.insert(pageView).values({ pageId: quiet.id, userId: bob, day: viewDay(at(-300 * DAY)), count: 2, lastViewedAt: at(-300 * DAY) });
  await deleteOldPageViews(now);
  rows = await rowsOf(quiet.id, bob);
  check(rows.length === 2 && !rows.some((r) => r.day === viewDay(at(-400 * DAY))), "views older than a year are deleted, younger ones kept", rows);
  await db.delete(page).where(eq(page.id, quiet.id));
  check((await rowsOf(quiet.id)).length === 0, "deleting a page deletes its views");
  await db.delete(user).where(eq(user.id, bob));
  check((await db.select().from(pageView).where(eq(pageView.userId, bob))).length === 0, "deleting a person deletes their views");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWs]));
  await db.delete(user).where(inArray(user.id, userIds));
  await db.$client.end();
}

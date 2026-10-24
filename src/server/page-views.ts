import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageView, user, type PageKind } from "@/db/schema";
import { type AnalyticsPeriod, periodStart } from "@/lib/analytics";
import {
  dailySeries,
  firstViewDay,
  oldestKeptViewDay,
  type PageAnalytics,
  type PageEditor,
  type PageViewer,
  VIEW_REPEAT_MS,
  viewDay,
} from "@/lib/page-views";
import { AccessError, accessRank, EDIT_RANK, getMembership, isGuest, pageVisibleTo, requireMembership } from "@/server/access";
import { editsSince } from "@/server/analytics";
import { listedPage } from "@/server/page-outdated";
import { startSweep } from "@/server/sweep";
import { pageViewRecording, setMemberPageViews, workspacePeople, workspaceSettings } from "@/server/workspaces";

/**
 * Page views: who opened which page, database or row in the app, for Settings > Analytics
 * (server/analytics.ts) and each page's Analytics. The browser sends a view once the page has
 * loaded (components/page/record-view.ts); it is kept as one row per page, person and UTC day
 * with a count. Recorded only for the workspace's owners and members, never for guests, agents,
 * connected apps, API tokens or visitors of published pages, and only while both the workspace
 * (WorkspaceSettings `pageViews`) and the person (their own switch, see pageViewRecording) let it.
 */

/** The page's workspace, whether it is in the trash, and the user's access rank on it, without its content. */
async function pageFor(userId: string, pageId: string) {
  const [found] = await db
    .select({ workspaceId: page.workspaceId, archivedAt: page.archivedAt, level: accessRank(userId, sql`${page.id}`) })
    .from(page)
    .where(eq(page.id, pageId))
    .limit(1);
  return found && Number(found.level) > 0 ? { ...found, level: Number(found.level) } : null;
}

/**
 * Records that the user opened the page at `now`; true when it counted as a view. Not counted: a
 * page they can't open or in the trash, a workspace whose sign-in policies hold their session
 * back, someone who isn't recorded (see above), and the same page again within VIEW_REPEAT_MS.
 */
export async function recordPageView(userId: string, pageId: string, now = new Date()): Promise<boolean> {
  const found = await pageFor(userId, pageId);
  if (!found || found.archivedAt) return false;
  // Also refuses a session the workspace's sign-in policies hold back.
  if (!(await getMembership(userId, found.workspaceId))) return false;
  if (!(await pageViewRecording(userId, found.workspaceId)).records) return false;
  const at = now.toISOString();
  const counted = await db.execute(sql`
    insert into ${pageView} (page_id, user_id, day, count, last_viewed_at)
    values (${pageId}, ${userId}, ${viewDay(now)}::date, 1, ${at}::timestamptz)
    on conflict (page_id, user_id, day) do update
      set count = ${pageView}.count + 1, last_viewed_at = excluded.last_viewed_at
      where ${pageView}.last_viewed_at <= excluded.last_viewed_at - ${`${VIEW_REPEAT_MS / 1000} seconds`}::interval
    returning 1
  `);
  return counted.length > 0;
}

/**
 * A page's Analytics over the last `days`: its views per day, who opened it and who edited it.
 * For the workspace's owners and members who may edit the page (AccessError for anyone else, the
 * same whether the page exists or not). Views are left out while the workspace doesn't record
 * them; people are listed only while they are owners or members of it.
 */
export async function pageAnalytics(userId: string, pageId: string, days: AnalyticsPeriod, now = new Date()): Promise<PageAnalytics> {
  const found = await pageFor(userId, pageId);
  if (!found || found.level < EDIT_RANK) throw new AccessError();
  const membership = await requireMembership(userId, found.workspaceId);
  if (isGuest(membership.role)) throw new AccessError();
  const recording = (await workspaceSettings(found.workspaceId)).pageViews !== false;
  const since = periodStart(now, days);
  const from = firstViewDay(now, days);

  const [people, daily, byViewer, byEditor] = await Promise.all([
    workspacePeople(found.workspaceId),
    recording
      ? db.execute<{ day: string; views: number }>(sql`
          select to_char(day, 'YYYY-MM-DD') as day, sum(count)::int as views
          from ${pageView}
          where page_id = ${pageId} and day >= ${from}::date
          group by day
        `)
      : [],
    recording
      ? db.execute<{ user_id: string; views: number; last_at: Date | string }>(sql`
          select user_id, sum(count)::int as views, max(last_viewed_at) as last_at
          from ${pageView}
          where page_id = ${pageId} and day >= ${from}::date
          group by user_id
        `)
      : [],
    db.execute<{ user_id: string; name: string; email: string; image: string | null; edits: number; last_at: Date | string }>(sql`
      with edits as (${editsSince(found.workspaceId, since, pageId)})
      select e.user_id, u.name, u.email, u.image, count(*)::int as edits, max(e.at) as last_at
      from edits e
      join ${user} u on u.id = e.user_id
      group by e.user_id, u.name, u.email, u.image
      order by edits desc, last_at desc
    `),
  ]);

  const members = new Map(people.filter((p) => !isGuest(p.role)).map((p) => [p.id, p]));
  const viewers: PageViewer[] = byViewer.flatMap((r) => {
    const p = members.get(r.user_id);
    return p ? [{ userId: p.id, name: p.name, email: p.email, image: p.image, views: Number(r.views), lastViewedAt: new Date(r.last_at) }] : [];
  });
  viewers.sort((a, b) => b.views - a.views || b.lastViewedAt.getTime() - a.lastViewedAt.getTime());
  const editors: PageEditor[] = byEditor.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    image: r.image,
    edits: Number(r.edits),
    lastEditAt: new Date(r.last_at),
  }));

  return {
    days,
    recording,
    views: byViewer.reduce((sum, r) => sum + Number(r.views), 0),
    viewers: byViewer.length,
    daily: recording ? dailySeries(daily, now, days) : [],
    people: viewers,
    editors,
  };
}

/**
 * Whether the pages the person opens in the workspace are recorded (`own`: their switch) while the
 * workspace records views (`workspace`); owners and members only.
 */
export async function ownPageViews(userId: string, workspaceId: string): Promise<{ own: boolean; workspace: boolean }> {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) throw new AccessError();
  const recording = await pageViewRecording(userId, workspaceId);
  return { own: recording.own !== false, workspace: recording.workspace };
}

/** Turns recording the pages the person opens in the workspace on or off; owners and members only. */
export async function setOwnPageViews(userId: string, workspaceId: string, on: boolean) {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role) || !(await setMemberPageViews(userId, workspaceId, on))) throw new AccessError();
}

/** Deletes the views older than PAGE_VIEW_RETENTION_DAYS; how many day rows went. */
export async function deleteOldPageViews(now = new Date()): Promise<number> {
  const gone = await db.execute(sql`delete from ${pageView} where day < ${oldestKeptViewDay(now)}::date returning 1`);
  return gone.length;
}

const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;

/** Server only: deletes old page views now and every few hours (started from server.ts). */
export function startPageViewRetention() {
  return startSweep(RETENTION_EVERY_MS, () => deleteOldPageViews(), "Deleting old page views failed");
}

export type ViewedPage = { id: string; title: string; icon: string | null; kind: PageKind; updatedAt: Date; viewedAt: Date };

/**
 * The pages the person opened in the workspace most recently, last opened first: "Jump back in" on
 * the home page and the search box before anything is typed. Only pages they may open now, out of
 * the trash, templates and the archive; access is asked of the latest views only, like
 * pages.recentPages. Null while their views aren't recorded (the workspace's or their own switch
 * is off, or they are a guest): then callers show the pages last edited instead, since views kept
 * from before recording was turned off no longer say what they are working on.
 */
export async function recentlyViewedPages(userId: string, workspaceId: string, limit = 8): Promise<ViewedPage[] | null> {
  await requireMembership(userId, workspaceId);
  if (!(await pageViewRecording(userId, workspaceId)).records) return null;
  const rows = await db.execute<{ id: string; title: string; icon: string | null; kind: PageKind; updated_at: Date | string; viewed_at: Date | string }>(sql`
    with viewed as (
      select v.page_id, max(v.last_viewed_at) as viewed_at
      from ${pageView} v
      where v.user_id = ${userId}
      group by v.page_id
    ),
    latest as (
      select p.id, p.title, p.icon, p.kind, p.updated_at, viewed.viewed_at
      from viewed
      join ${page} p on p.id = viewed.page_id
      where p.workspace_id = ${workspaceId} and ${listedPage(workspaceId, { alias: "p" })}
      order by viewed.viewed_at desc
      limit ${Math.max(100, limit * 10)}
      -- Ranked first, then checked in that order: "offset 0" keeps the check out of the ranked set.
      offset 0
    )
    select * from latest
    where ${pageVisibleTo(userId, "latest")}
    order by viewed_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind, updatedAt: new Date(r.updated_at), viewedAt: new Date(r.viewed_at) }));
}

import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, pageUpdateEmail, pageWatch, pendingPageUpdate, teamspace, teamspaceWatch, workspace } from "@/db/schema";
import { redactError } from "@/lib/redact";
import { PAGE_EMAIL_WINDOW_MS, PAGE_UPDATE_IDLE_MS, PAGE_UPDATE_MAX_WAIT_MS, pageUpdateAudience, pageWatchers } from "@/lib/page-watch";
import { AccessError, pageVisibleTo, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { requestLocale } from "@/server/mail/locale";
import { pageRecipients, recordPageUpdate } from "@/server/notifications";
import { rowFollowers } from "@/server/row-follow";
import { startSweep } from "@/server/sweep";
import { getTeamspace } from "@/server/teamspaces";

/**
 * Watching pages: the people who watch a page hear in their inbox (and by email and push, as they
 * choose) when someone else edits it, and about new comment threads on it. A page's creator watches
 * it, and so does anyone who edits it or watches its whole teamspace (`teamspace_watch`); anyone
 * who can open it may watch or mute it (`page_watch`), and a mute wins over all of these. Database
 * rows aren't watched: their followers hear about them instead (server/row-follow.ts), and neither
 * are templates.
 *
 * Each person's edits wait in `page_update_pending` until they leave the page alone for a while
 * (lib/page-watch `pageUpdateDueAt`), so a session of writing is one notification; who watches, who
 * can still open the page and who has it open right now (and so saw it change) are worked out when
 * it goes out. Emails about it are held back further (server/share-emails.ts). Nothing here throws
 * into the write it is about.
 */

/** How often the server looks for page updates that are due. */
const SWEEP_INTERVAL_MS = 5_000;
/** How long sent page-update emails are remembered: their cooldown and daily cap look back less. */
const EMAIL_LOG_MS = 2 * PAGE_EMAIL_WINDOW_MS;

const parent = alias(page, "parent");

/** The page with what deciding who watches it needs; null for database rows and templates, which aren't watched. */
async function loadWatchable(pageId: string) {
  const [found] = await db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      teamspaceId: page.teamspaceId,
      createdBy: page.createdBy,
      archivedAt: page.archivedAt,
      isTemplate: page.isTemplate,
      inTemplate: page.inTemplate,
      parentKind: parent.kind,
    })
    .from(page)
    .leftJoin(parent, eq(parent.id, page.parentId))
    .where(eq(page.id, pageId));
  if (!found || found.parentKind === "database" || found.isTemplate || found.inTemplate) return null;
  return found;
}

type Watchable = NonNullable<Awaited<ReturnType<typeof loadWatchable>>>;

async function watchersOf(target: Watchable): Promise<string[]> {
  const [chosen, teamspaceWatchers] = await Promise.all([
    db.select({ userId: pageWatch.userId, watching: pageWatch.watching }).from(pageWatch).where(eq(pageWatch.pageId, target.id)),
    target.teamspaceId
      ? db.select({ userId: teamspaceWatch.userId }).from(teamspaceWatch).where(eq(teamspaceWatch.teamspaceId, target.teamspaceId))
      : [],
  ]);
  return pageWatchers({ createdBy: target.createdBy, teamspaceWatchers: teamspaceWatchers.map((w) => w.userId), chosen });
}

/** Whether `userId` watches the page; null for database rows and templates, which aren't watched. */
export async function isWatching(userId: string, pageId: string): Promise<boolean | null> {
  const target = await loadWatchable(pageId);
  return target ? (await watchersOf(target)).includes(userId) : null;
}

/**
 * Who hears about a new comment thread on the page: its watchers, a database row's followers, and
 * for anything else (a template) its creator. Whether they can still open it is checked apart.
 */
export async function newThreadAudience(pageId: string, createdBy: string | null): Promise<string[]> {
  const followers = await rowFollowers(pageId);
  if (followers) return followers;
  const target = await loadWatchable(pageId);
  if (target) return watchersOf(target);
  return createdBy ? [createdBy] : [];
}

/**
 * Watches the page (true) or mutes it (false), for someone who can open it. A mute wins over being
 * its creator, an editor or watching its teamspace; watching again undoes it.
 */
export async function setWatching(userId: string, pageId: string, watching: boolean) {
  await requirePageAccess(userId, pageId, "view");
  if (!(await loadWatchable(pageId))) throw new Error("Database rows are followed, and templates aren't watched");
  await db
    .insert(pageWatch)
    .values({ pageId, userId, watching })
    .onConflictDoUpdate({ target: [pageWatch.pageId, pageWatch.userId], set: { watching, updatedAt: new Date() } });
  return watching;
}

/** Whether `userId` watches every page of the teamspace (they must be able to see it). */
export async function isWatchingTeamspace(userId: string, teamspaceId: string) {
  await getTeamspace(userId, teamspaceId);
  const [row] = await db
    .select({ userId: teamspaceWatch.userId })
    .from(teamspaceWatch)
    .where(and(eq(teamspaceWatch.teamspaceId, teamspaceId), eq(teamspaceWatch.userId, userId)));
  return Boolean(row);
}

/** Watches every page of a teamspace the user can see, or stops; pages they muted stay muted. */
export async function setWatchingTeamspace(userId: string, teamspaceId: string, watching: boolean) {
  const found = await getTeamspace(userId, teamspaceId);
  if (watching) await db.insert(teamspaceWatch).values({ teamspaceId, userId }).onConflictDoNothing();
  else await db.delete(teamspaceWatch).where(and(eq(teamspaceWatch.teamspaceId, teamspaceId), eq(teamspaceWatch.userId, userId)));
  return { watching, workspaceId: found.workspaceId };
}

export type WatchedPage = { id: string; workspaceId: string; workspaceName: string; title: string; icon: string | null };
export type WatchedTeamspace = { id: string; workspaceId: string; workspaceName: string; name: string; icon: string | null };

/**
 * What the user chose to watch, or edited, in every workspace, for their notification settings: the
 * pages they can still open (not in the trash), and the teamspaces they watch. Pages they watch only
 * for having made them aren't listed (muting one is done on the page).
 */
export async function listWatches(userId: string): Promise<{ pages: WatchedPage[]; teamspaces: WatchedTeamspace[] }> {
  const [pages, teamspaces] = await Promise.all([
    db
      .select({ id: page.id, workspaceId: page.workspaceId, workspaceName: workspace.name, title: page.title, icon: page.icon })
      .from(pageWatch)
      .innerJoin(page, eq(page.id, pageWatch.pageId))
      .innerJoin(workspace, eq(workspace.id, page.workspaceId))
      .where(and(eq(pageWatch.userId, userId), eq(pageWatch.watching, true), isNull(page.archivedAt), pageVisibleTo(userId)))
      .orderBy(asc(workspace.name), asc(page.title))
      .limit(500),
    db
      .select({ id: teamspace.id, workspaceId: teamspace.workspaceId, workspaceName: workspace.name, name: teamspace.name, icon: teamspace.icon })
      .from(teamspaceWatch)
      .innerJoin(teamspace, eq(teamspace.id, teamspaceWatch.teamspaceId))
      .innerJoin(workspace, eq(workspace.id, teamspace.workspaceId))
      .where(eq(teamspaceWatch.userId, userId))
      .orderBy(asc(workspace.name), asc(teamspace.name)),
  ]);
  // A teamspace they can no longer see (they left a private one, or the workspace) isn't theirs to list.
  const visible = await Promise.all(
    teamspaces.map((t) =>
      getTeamspace(userId, t.id).then(
        () => true,
        (error) => {
          if (error instanceof AccessError) return false;
          throw error;
        },
      ),
    ),
  );
  return { pages, teamspaces: teamspaces.filter((_, i) => visible[i]) };
}

/**
 * A save of a page's document by `writers` changed its title or body: they watch it from now on
 * (unless they muted it), and its other watchers hear about it once each writer leaves it alone
 * (see pageUpdateDueAt). Database rows and templates are left out. Never throws.
 */
export async function queuePageSave(writers: string[], pageId: string, locale: string | null) {
  const people = [...new Set(writers)];
  if (!people.length) return;
  try {
    if (!(await loadWatchable(pageId))) return;
    // Editing watches the page; a mute stays.
    await db
      .insert(pageWatch)
      .values(people.map((userId) => ({ pageId, userId, watching: true })))
      .onConflictDoNothing();
    const language = locale ?? (await requestLocale());
    const now = new Date();
    for (const actorId of people) {
      await db
        .insert(pendingPageUpdate)
        .values({ pageId, actorId, locale: language, firstAt: now, dueAt: new Date(now.getTime() + PAGE_UPDATE_IDLE_MS) })
        .onConflictDoUpdate({
          target: [pendingPageUpdate.pageId, pendingPageUpdate.actorId],
          // Same as pageUpdateDueAt, in one statement so two saves at once can't both start the wait.
          set: {
            dueAt: sql`least(excluded.due_at, ${pendingPageUpdate.firstAt} + make_interval(secs => ${PAGE_UPDATE_MAX_WAIT_MS / 1000}))`,
          },
        });
    }
  } catch (error) {
    console.error("[page-watch] could not queue a page update", redactError(error));
  }
}

/**
 * Tells the page's watchers but its author, who can still open it and don't have it open right
 * now, that it was edited.
 */
async function deliver(pending: typeof pendingPageUpdate.$inferSelect) {
  const target = await loadWatchable(pending.pageId);
  if (!target || target.archivedAt) return;
  const audience = pageUpdateAudience(await watchersOf(target), pending.actorId, getCollab().openUserIds(target.id));
  const recipients = await pageRecipients(audience, target.id);
  await recordPageUpdate(pending.actorId, target.workspaceId, target.id, recipients, pending.locale);
}

/** Takes the due updates off the queue (all of them with `everything`) and tells the pages' watchers. */
async function deliverDue(everything = false) {
  // Deleting before telling means each goes out at most once, even with two sweeps racing.
  const due = await db
    .delete(pendingPageUpdate)
    .where(everything ? undefined : lte(pendingPageUpdate.dueAt, new Date()))
    .returning();
  for (const entry of due) {
    try {
      await deliver(entry);
    } catch (error) {
      console.error("[page-watch] could not deliver a page update", redactError(error));
    }
  }
  await db.delete(pageUpdateEmail).where(lte(pageUpdateEmail.sentAt, new Date(Date.now() - EMAIL_LOG_MS)));
}

/** Server only: tells watchers about edits as they fall due, including any left from before a restart. */
export function startPageUpdates() {
  return startSweep(SWEEP_INTERVAL_MS, () => deliverDue(), "could not deliver page updates");
}

/** Scripts and tests: deliver everything queued now instead of after the delay. */
export async function flushPageUpdates() {
  await deliverDue(true);
}

/** Scripts and tests: the edits waiting to go out, by page. */
export async function pendingPageUpdates(pageIds: string[]) {
  if (!pageIds.length) return [];
  return db.select().from(pendingPageUpdate).where(inArray(pendingPageUpdate.pageId, pageIds));
}

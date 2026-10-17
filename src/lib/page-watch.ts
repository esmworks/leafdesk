/**
 * Watching pages (server/page-watch.ts): who hears about a page's edits and new comment threads,
 * and how often page-update emails go out. Pure and client-safe.
 */

/**
 * The people watching a page: its creator, anyone in `teamspaceWatchers` (they watch the page's
 * whole teamspace) and those who chose to watch it or edited it (`chosen` true), but never those
 * who muted it (`chosen` false), which wins over everything else.
 */
export function pageWatchers({
  createdBy,
  teamspaceWatchers = [],
  chosen,
}: {
  createdBy: string | null;
  teamspaceWatchers?: readonly string[];
  chosen: readonly { userId: string; watching: boolean }[];
}): string[] {
  const watchers = new Set([...(createdBy ? [createdBy] : []), ...teamspaceWatchers]);
  for (const { userId, watching } of chosen) if (watching) watchers.add(userId);
  for (const { userId, watching } of chosen) if (!watching) watchers.delete(userId);
  return [...watchers];
}

/**
 * Who hears that `actorId` changed a page: its watchers but the author, and not those who have the
 * page open right now (they watched it change). Whether they can still open it is checked apart.
 */
export function pageUpdateAudience(watchers: readonly string[], actorId: string | null, openNow: Iterable<string>): string[] {
  const open = new Set(openNow);
  return [...new Set(watchers)].filter((id) => id !== actorId && !open.has(id));
}

/**
 * An edit waits until its author has left the page alone this long, so a session of writing is one
 * notification…
 */
export const PAGE_UPDATE_IDLE_MS = 2 * 60_000;
/** …and no longer than this after its first change, so someone who keeps writing is still heard. */
export const PAGE_UPDATE_MAX_WAIT_MS = 15 * 60_000;

/** When an edit first made at `firstAt` and continued at `now` goes out. */
export function pageUpdateDueAt(firstAt: Date, now: Date): Date {
  return new Date(Math.min(now.getTime() + PAGE_UPDATE_IDLE_MS, firstAt.getTime() + PAGE_UPDATE_MAX_WAIT_MS));
}

/** After an email about a page, the next one about the same page waits at least this long. */
export const PAGE_EMAIL_COOLDOWN_MS = 4 * 3_600_000;
/** At most this many page-update emails a person gets in any 24 hours; what comes after waits for a digest. */
export const PAGE_EMAIL_DAILY_CAP = 5;
export const PAGE_EMAIL_WINDOW_MS = 24 * 3_600_000;

export type PageEmailPlan = {
  /** Notifications that each get their own email now. */
  single: string[];
  /** Notifications that go out together in one digest email now. */
  digest: string[];
  /** Notifications whose email waits until then. */
  later: { id: string; until: Date }[];
};

/**
 * What to do with one person's page-update emails that fell due together (`due`, one per page),
 * given when they were last emailed about each page (`lastSentByPage`) and when each of the emails
 * they got in the last 24 hours went out (`sentInWindow`; a digest counts once).
 *
 * - A page they heard about less than PAGE_EMAIL_COOLDOWN_MS ago waits for the cooldown to end.
 * - The rest go out each on its own while that keeps them within PAGE_EMAIL_DAILY_CAP; otherwise
 *   all of them go out as one digest, which takes one place in the cap.
 * - With the cap used up, they wait until the oldest email of the window turns 24 hours old.
 */
export function planPageEmails({
  now,
  due,
  lastSentByPage,
  sentInWindow,
}: {
  now: Date;
  due: readonly { id: string; pageId: string }[];
  lastSentByPage: ReadonlyMap<string, Date>;
  sentInWindow: readonly Date[];
}): PageEmailPlan {
  const plan: PageEmailPlan = { single: [], digest: [], later: [] };
  const ready: string[] = [];
  for (const { id, pageId } of due) {
    const last = lastSentByPage.get(pageId);
    const cooled = last ? last.getTime() + PAGE_EMAIL_COOLDOWN_MS : 0;
    if (cooled > now.getTime()) plan.later.push({ id, until: new Date(cooled) });
    else ready.push(id);
  }
  if (!ready.length) return plan;
  const window = sentInWindow.filter((t) => t.getTime() > now.getTime() - PAGE_EMAIL_WINDOW_MS).sort((a, b) => a.getTime() - b.getTime());
  const free = PAGE_EMAIL_DAILY_CAP - window.length;
  if (free <= 0) {
    const until = new Date(window[0]!.getTime() + PAGE_EMAIL_WINDOW_MS);
    plan.later.push(...ready.map((id) => ({ id, until })));
  } else if (ready.length <= free) {
    plan.single = ready;
  } else {
    plan.digest = ready;
  }
  return plan;
}

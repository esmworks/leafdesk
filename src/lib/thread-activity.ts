/**
 * What the page's comments panel tells about each thread for the person looking: when it last had
 * a comment (newest activity first), and whether others wrote in it since that person last saw it
 * (server/thread-state.ts keeps when). Pure; dates as Date or ISO strings.
 */

type When = Date | string;
type ActivityComment = { userId: string; createdAt: When; deletedAt?: When | null };
export type ActivityThread = { id: string; createdAt: When; comments: readonly ActivityComment[] };

const ms = (value: When | null | undefined) => (value ? new Date(value).getTime() : Number.NaN);

/** When the thread last had a comment (or was started), in ms. */
export function lastActivity(thread: ActivityThread): number {
  let latest = ms(thread.createdAt);
  for (const c of thread.comments) {
    const at = ms(c.createdAt);
    if (!(at <= latest)) latest = at;
  }
  return Number.isNaN(latest) ? 0 : latest;
}

/**
 * The threads with comments by others since `viewerId` last saw them (`seen`: thread id → when).
 * A thread they never saw counts from the last time they saw any thread of the page, so threads
 * started since show as new too; someone who never looked at the page's comments has nothing new.
 * The viewer's own comments count as seeing the thread.
 */
export function newThreadIds(threads: readonly ActivityThread[], viewerId: string, seen: Readonly<Record<string, When>>): Set<string> {
  const times = Object.values(seen).map(ms).filter((t) => !Number.isNaN(t));
  const fresh = new Set<string>();
  if (!times.length) return fresh;
  const baseline = Math.max(...times);
  for (const thread of threads) {
    let since = seen[thread.id] !== undefined ? ms(seen[thread.id]) : baseline;
    for (const c of thread.comments) if (c.userId === viewerId && ms(c.createdAt) > since) since = ms(c.createdAt);
    if (thread.comments.some((c) => c.userId !== viewerId && !c.deletedAt && ms(c.createdAt) > since)) fresh.add(thread.id);
  }
  return fresh;
}

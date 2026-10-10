import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { calendarFeed, databaseView } from "@/db/schema";
import { env } from "@/lib/env";
import { icsCalendar, type IcsEvent } from "@/lib/ics";
import { pageLabel } from "@/lib/labels";
import { isIsoDate } from "@/lib/mentions";
import { viewDateProperty } from "@/lib/views";
import { sharedLimiter } from "@/lib/rate-limit";
import { AccessError } from "@/server/access";
import { generateTokenSecret, hashToken, TOKEN_PREFIX } from "@/server/api/tokens";
import { runAsConnectedApp } from "@/server/connected-app";
import { getProperties, requireDatabase, viewedRows, withCode } from "@/server/databases";
import { exportAllowed } from "@/server/workspaces";

/**
 * Calendar feeds: a calendar view's rows as an iCalendar address that calendar apps subscribe to,
 * each row an all-day event on its date. The address holds a secret standing for its user; every
 * read sees what that user may see then (the view's filters, page and property access), so taking
 * their access away, or the workspace turning export or connected apps off, empties or stops the
 * feed. Like an API token it reads outside the workspace's sign-in policies, as a connected app (see
 * connected-app.ts). Only a hash of the secret is kept (see calendar_feed).
 */

/** The secret's start, to tell it from other tokens. */
const FEED_PREFIX = "ldcal_";
const FEED_PATTERN = /^ldcal_[A-Za-z0-9]{36}$/;
/** Reads per feed and minute: calendar apps check back every so often, not every second. */
const READS_PER_MINUTE = 30;
const LAST_USED_EVERY_MS = 3_600_000;

/** Whether the workspace allows feeds, and the user's feed of the view (null: none). */
export type CalendarFeedInfo = { allowed: boolean; feed: { createdAt: Date; lastUsedAt: Date | null } | null };

async function requireCalendarView(userId: string, viewId: string) {
  // A deleted view's feed reads as gone, and works again once the view is restored.
  const [view] = await db
    .select()
    .from(databaseView)
    .where(and(eq(databaseView.id, viewId), isNull(databaseView.deletedAt)))
    .limit(1);
  if (!view) throw new AccessError();
  const database = await requireDatabase(userId, view.databaseId, "view");
  if (view.type !== "calendar") throw withCode(new Error("Only calendar views have a feed"), "calendarFeedNotCalendar");
  return { view, database };
}

/** The feed's address for a secret. */
const calendarFeedUrl = (secret: string) => `${env.appUrl}/api/calendar/${secret}.ics`;

/** Whether the user has a feed of the view, and since when. */
export async function getCalendarFeed(userId: string, viewId: string): Promise<CalendarFeedInfo> {
  const { database } = await requireCalendarView(userId, viewId);
  const [allowed, [feed]] = await Promise.all([
    exportAllowed(database.workspaceId),
    db
      .select({ createdAt: calendarFeed.createdAt, lastUsedAt: calendarFeed.lastUsedAt })
      .from(calendarFeed)
      .where(and(eq(calendarFeed.userId, userId), eq(calendarFeed.viewId, viewId))),
  ]);
  return { allowed, feed: feed ?? null };
}

/**
 * Makes the user a feed of the view, replacing the one they had (whose address stops working),
 * and returns its address: the only time it is shown.
 */
export async function createCalendarFeed(userId: string, viewId: string): Promise<string> {
  const { database } = await requireCalendarView(userId, viewId);
  if (!(await exportAllowed(database.workspaceId))) {
    throw withCode(new Error("The workspace's owners turned export off"), "calendarFeedExportOff");
  }
  const secret = FEED_PREFIX + generateTokenSecret().slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 36);
  await db.transaction(async (tx) => {
    await tx.delete(calendarFeed).where(and(eq(calendarFeed.userId, userId), eq(calendarFeed.viewId, viewId)));
    await tx.insert(calendarFeed).values({ userId, viewId, tokenHash: hashToken(secret) });
  });
  return calendarFeedUrl(secret);
}

/** Stops the user's feed of the view. */
export async function deleteCalendarFeed(userId: string, viewId: string) {
  await requireCalendarView(userId, viewId);
  await db.delete(calendarFeed).where(and(eq(calendarFeed.userId, userId), eq(calendarFeed.viewId, viewId)));
}

type FeedRead = { status: 200; body: string; name: string } | { status: 404 | 429 };

/**
 * The feed with secret `secret` as iCalendar text, read as its user. 404 for an unknown secret, a
 * view no longer a calendar or the user's lost access, and while the workspace's export or
 * connected apps are off; 429 when read too often.
 */
export async function readCalendarFeed(secret: string, now = new Date()): Promise<FeedRead> {
  if (!FEED_PATTERN.test(secret)) return { status: 404 };
  const tokenHash = hashToken(secret);
  const limiter = sharedLimiter("calendar-feed", READS_PER_MINUTE, 60_000);
  if (limiter.retryAfter(tokenHash) > 0) return { status: 429 };
  limiter.hit(tokenHash);

  const [feed] = await db.select().from(calendarFeed).where(eq(calendarFeed.tokenHash, tokenHash)).limit(1);
  if (!feed) return { status: 404 };
  return runAsConnectedApp({ userId: feed.userId }, () => feedText(feed, now));
}

async function feedText(feed: typeof calendarFeed.$inferSelect, now: Date): Promise<FeedRead> {
  let found;
  try {
    found = await requireCalendarView(feed.userId, feed.viewId);
  } catch {
    return { status: 404 };
  }
  const { view, database } = found;
  const [allowed, properties] = await Promise.all([
    exportAllowed(database.workspaceId),
    getProperties(database.id),
    feed.lastUsedAt && now.getTime() - feed.lastUsedAt.getTime() <= LAST_USED_EVERY_MS
      ? null
      : db.update(calendarFeed).set({ lastUsedAt: now }).where(eq(calendarFeed.id, feed.id)),
  ]);
  if (!allowed) return { status: 404 };

  // As the calendar view places rows.
  const dateBy = viewDateProperty(view.config, properties);
  // requireCalendarView checked the database.
  const rows = dateBy ? await viewedRows(feed.userId, database.id, view.config, properties) : [];
  const host = new URL(env.appUrl).host;
  const events: IcsEvent[] = rows.flatMap((row) => {
    const value = row.properties[dateBy!.id];
    if (!isIsoDate(value)) return [];
    return [
      {
        uid: `${row.id}@${host}`,
        day: value,
        title: pageLabel(row.title, "Untitled"),
        url: `${env.appUrl}/w/${database.workspaceId}/p/${row.id}`,
        updatedAt: row.updatedAt,
      },
    ];
  });
  const name = `${pageLabel(database.title, "Untitled")} · ${view.name}`;
  return { status: 200, body: icsCalendar(name, events), name };
}

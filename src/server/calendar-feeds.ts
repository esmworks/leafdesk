import { and, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { calendarFeed, databaseView, workspace } from "@/db/schema";
import enHome from "@/i18n/messages/en/home.json";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import { env } from "@/lib/env";
import { icsCalendar, type IcsEvent } from "@/lib/ics";
import { pageLabel } from "@/lib/labels";
import { parseDateValue } from "@/lib/date-value";
import { viewDateProperty } from "@/lib/views";
import { sharedLimiter } from "@/lib/rate-limit";
import { isTimeZone } from "@/lib/time-zone";
import { AccessError, requireMembership } from "@/server/access";
import { generateTokenSecret, hashToken, TOKEN_PREFIX } from "@/server/api/tokens";
import { openAssignedRows } from "@/server/assigned";
import { runAsConnectedApp } from "@/server/connected-app";
import { getProperties, requireDatabase, viewedRows, withCode } from "@/server/databases";
import { pickLocale, savedLocale } from "@/server/mail/locale";
import { exportAllowed } from "@/server/workspaces";

/**
 * Calendar feeds: database rows as an iCalendar address that calendar apps subscribe to, each row
 * an event on its date. A feed holds either a calendar view's rows or the rows assigned to its user
 * across a workspace (as the home page lists them, see server/assigned). The address holds a secret
 * standing for its user; every read sees what that user may see then (the view's filters, page and
 * property access), so taking their access away, or the workspace turning export or connected apps
 * off, empties or stops the feed. Like an API token it reads outside the workspace's sign-in
 * policies, as a connected app (see connected-app.ts). Only a hash of the secret is kept (see
 * calendar_feed).
 */

/** The secret's start, to tell it from other tokens. */
const FEED_PREFIX = "ldcal_";
const FEED_PATTERN = /^ldcal_[A-Za-z0-9]{36}$/;
/** Reads per feed and minute: calendar apps check back every so often, not every second. */
const READS_PER_MINUTE = 30;
const LAST_USED_EVERY_MS = 3_600_000;

/** Whether the workspace allows feeds, and the user's feed (null: none). */
export type CalendarFeedInfo = { allowed: boolean; feed: { createdAt: Date; lastUsedAt: Date | null } | null };

/** Which of the user's feeds an operation is about: its workspace, its rows and the row it is kept in. */
type FeedScope = { workspaceId: string; where: SQL; values: { viewId: string } | { workspaceId: string } };

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

async function viewScope(userId: string, viewId: string): Promise<FeedScope> {
  const { database } = await requireCalendarView(userId, viewId);
  return {
    workspaceId: database.workspaceId,
    where: and(eq(calendarFeed.userId, userId), eq(calendarFeed.viewId, viewId))!,
    values: { viewId },
  };
}

async function assignedScope(userId: string, workspaceId: string): Promise<FeedScope> {
  await requireMembership(userId, workspaceId);
  return {
    workspaceId,
    where: and(eq(calendarFeed.userId, userId), eq(calendarFeed.workspaceId, workspaceId), isNull(calendarFeed.viewId))!,
    values: { workspaceId },
  };
}

/** The feed's address for a secret. */
const calendarFeedUrl = (secret: string) => `${env.appUrl}/api/calendar/${secret}.ics`;

async function feedInfo(scope: FeedScope, timeZone: string | undefined): Promise<CalendarFeedInfo> {
  const [allowed, [feed]] = await Promise.all([
    exportAllowed(scope.workspaceId),
    db.select({ createdAt: calendarFeed.createdAt, lastUsedAt: calendarFeed.lastUsedAt }).from(calendarFeed).where(scope.where),
    // A feed made before feeds kept a zone takes the one its user opens it in.
    isTimeZone(timeZone) ? db.update(calendarFeed).set({ timeZone }).where(and(scope.where, isNull(calendarFeed.timeZone))) : null,
  ]);
  return { allowed, feed: feed ?? null };
}

async function createFeed(userId: string, scope: FeedScope, timeZone: string | undefined): Promise<string> {
  if (!(await exportAllowed(scope.workspaceId))) {
    throw withCode(new Error("The workspace's owners turned export off"), "calendarFeedExportOff");
  }
  const secret = FEED_PREFIX + generateTokenSecret().slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 36);
  await db.transaction(async (tx) => {
    await tx.delete(calendarFeed).where(scope.where);
    await tx.insert(calendarFeed).values({ userId, ...scope.values, tokenHash: hashToken(secret), timeZone: isTimeZone(timeZone) ? timeZone : null });
  });
  return calendarFeedUrl(secret);
}

/** Whether the user has a feed of the view, and since when. `timeZone` is theirs (see calendarFeed.timeZone). */
export async function getCalendarFeed(userId: string, viewId: string, timeZone?: string): Promise<CalendarFeedInfo> {
  return feedInfo(await viewScope(userId, viewId), timeZone);
}

/**
 * Makes the user a feed of the view, replacing the one they had (whose address stops working),
 * and returns its address: the only time it is shown. Its days are theirs in `timeZone`.
 */
export async function createCalendarFeed(userId: string, viewId: string, timeZone?: string): Promise<string> {
  return createFeed(userId, await viewScope(userId, viewId), timeZone);
}

/** Stops the user's feed of the view. */
export async function deleteCalendarFeed(userId: string, viewId: string) {
  const scope = await viewScope(userId, viewId);
  await db.delete(calendarFeed).where(scope.where);
}

/** Whether the user has a feed of the rows assigned to them in the workspace, and since when. */
export async function getAssignedCalendarFeed(userId: string, workspaceId: string, timeZone?: string): Promise<CalendarFeedInfo> {
  return feedInfo(await assignedScope(userId, workspaceId), timeZone);
}

/**
 * Makes the user a feed of the rows assigned to them in the workspace, replacing the one they had,
 * and returns its address: the only time it is shown.
 */
export async function createAssignedCalendarFeed(userId: string, workspaceId: string, timeZone?: string): Promise<string> {
  return createFeed(userId, await assignedScope(userId, workspaceId), timeZone);
}

/** Stops the user's feed of the rows assigned to them in the workspace. */
export async function deleteAssignedCalendarFeed(userId: string, workspaceId: string) {
  const scope = await assignedScope(userId, workspaceId);
  await db.delete(calendarFeed).where(scope.where);
}

type FeedRead = { status: 200; body: string; name: string } | { status: 404 | 429 };
type Feed = typeof calendarFeed.$inferSelect;

/**
 * The feed with secret `secret` as iCalendar text, read as its user. 404 for an unknown secret, a
 * view no longer a calendar, the user's lost access or membership, and while the workspace's export
 * or connected apps are off; 429 when read too often.
 */
export async function readCalendarFeed(secret: string, now = new Date()): Promise<FeedRead> {
  if (!FEED_PATTERN.test(secret)) return { status: 404 };
  const tokenHash = hashToken(secret);
  const limiter = sharedLimiter("calendar-feed", READS_PER_MINUTE, 60_000);
  if (limiter.retryAfter(tokenHash) > 0) return { status: 429 };
  limiter.hit(tokenHash);

  const [feed] = await db.select().from(calendarFeed).where(eq(calendarFeed.tokenHash, tokenHash)).limit(1);
  if (!feed) return { status: 404 };
  return runAsConnectedApp({ userId: feed.userId }, () =>
    feed.viewId ? viewFeedText(feed, feed.viewId, now) : assignedFeedText(feed, feed.workspaceId!, now),
  );
}

/** Whether the workspace allows the feed, recording the read (at most once an hour). */
async function feedAllowed(feed: Feed, workspaceId: string, now: Date) {
  const [allowed] = await Promise.all([
    exportAllowed(workspaceId),
    feed.lastUsedAt && now.getTime() - feed.lastUsedAt.getTime() <= LAST_USED_EVERY_MS
      ? null
      : db.update(calendarFeed).set({ lastUsedAt: now }).where(eq(calendarFeed.id, feed.id)),
  ]);
  return allowed;
}

/** A row as an event on `date`, a date property's value; null when it isn't a date. */
function rowEvent(
  row: { id: string; title: string; updatedAt: Date },
  date: unknown,
  workspaceId: string,
  description?: string,
): IcsEvent | null {
  if (!parseDateValue(date)) return null;
  return {
    uid: `${row.id}@${new URL(env.appUrl).host}`,
    date: date as string,
    title: pageLabel(row.title, "Untitled"),
    description,
    url: `${env.appUrl}/w/${workspaceId}/p/${row.id}`,
    updatedAt: row.updatedAt,
  };
}

async function viewFeedText(feed: Feed, viewId: string, now: Date): Promise<FeedRead> {
  let found;
  try {
    found = await requireCalendarView(feed.userId, viewId);
  } catch {
    return { status: 404 };
  }
  const { view, database } = found;
  const [allowed, properties] = await Promise.all([feedAllowed(feed, database.workspaceId, now), getProperties(database.id)]);
  if (!allowed) return { status: 404 };

  // As the calendar view places rows, on the feed's user's days ("today" in a filter is theirs).
  const dateBy = viewDateProperty(view.config, properties);
  // requireCalendarView checked the database.
  const timeZone = isTimeZone(feed.timeZone) ? feed.timeZone : "UTC";
  const rows = dateBy ? await viewedRows(feed.userId, database.id, view.config, properties, { now, timeZone }) : [];
  const events = rows.flatMap((row) => rowEvent(row, row.properties[dateBy!.id], database.workspaceId) ?? []);
  const name = `${pageLabel(database.title, "Untitled")} · ${view.name}`;
  return { status: 200, body: icsCalendar(name, events), name };
}

async function assignedFeedText(feed: Feed, workspaceId: string, now: Date): Promise<FeedRead> {
  try {
    await requireMembership(feed.userId, workspaceId);
  } catch {
    return { status: 404 };
  }
  const [allowed, [space], label] = await Promise.all([
    feedAllowed(feed, workspaceId, now),
    db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)),
    assignedLabel(feed.userId),
  ]);
  if (!allowed || !space) return { status: 404 };

  const rows = await openAssignedRows(feed.userId, workspaceId);
  // Each row on the first date its user may see, with its database's name when they may open it.
  const events = rows.flatMap(
    (row) => rowEvent(row, row.dateValue, workspaceId, row.databaseTitle === null ? undefined : pageLabel(row.databaseTitle, "Untitled")) ?? [],
  );
  const name = `${space.name} · ${label}`;
  return { status: 200, body: icsCalendar(name, events), name };
}

/**
 * "Assigned to you" in the language the user last used the app in (see server/mail/locale.ts), else
 * English: a feed is read by a calendar app, which says nothing of its user's language.
 */
async function assignedLabel(userId: string): Promise<string> {
  const locale = pickLocale(await savedLocale(userId));
  return withFallback(enHome, await loadLocaleFile(locale, "home")).assigned;
}

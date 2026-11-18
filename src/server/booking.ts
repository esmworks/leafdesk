import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookingLink, notification, user } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import {
  atLeastLong,
  BOOKING_LIMITS,
  bookableSlots,
  busyFromDates,
  scheduleProblem,
  slotInterval,
  slotIsOffered,
  takeOut,
  workingWindows,
  type BookingSchedule,
  type BookingScheduleProblem,
  type Interval,
} from "@/lib/booking";
import { ipRateKey } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { dayString, isTimeZone, localDay, wallClock } from "@/lib/time-zone";
import { requireMembership } from "@/server/access";
import { busyDates } from "@/server/calendar";
import { createVisitorEvent, writableCalendars, type WritableCalendar } from "@/server/calendar-events";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { sendMail } from "@/server/mail";
import { emailTranslator, bookingConfirmationEmail } from "@/server/mail/templates";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";

/**
 * Booking links: a person's public page `/b/<token>` (src/app/b) where a visitor, signed in or not,
 * picks a time the person is free (lib/booking.ts, out of what server/calendar.ts `busyDates` says
 * is taken), gives a name, an email address and a note, and gets the time as a row of the calendar
 * database the link was made for, a Google Calendar synced both ways (server/calendar-events.ts),
 * which the sync writes back. The owner hears of it in their inbox (`booking_made`), the visitor by
 * email. Visitors learn nothing of the calendar but which starts are free: no titles, no busy times,
 * and a link that doesn't work for any reason answers as a link that never was.
 */

export type BookingErrorCode =
  | "invalid"
  | "notFound"
  | "noCalendar"
  | "tooMany"
  | "closed"
  | "slotTaken"
  | "expired"
  | "tooFast"
  | "rateLimited"
  | "invalidAnswers";

export class BookingError extends Error {
  constructor(
    readonly code: BookingErrorCode,
    message: string,
    /** For "invalid": which part of the link. */
    readonly problem: BookingScheduleProblem | "title" | "description" | "database" | null = null,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/** Links one person may have in a workspace. */
export const MAX_BOOKING_LINKS = 20;

// ---------------------------------------------------------------------------------------------
// Managing links

export type BookingLinkInput = {
  title: string;
  description: string;
  databaseId: string;
  durationMinutes: number;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  bufferMinutes: number;
  daysAhead: number;
  minNoticeMinutes: number;
  /** The person's own: the hours above are wall-clock times there. */
  timeZone: string;
};

export type BookingLinkView = BookingLinkInput & {
  id: string;
  url: string;
  enabled: boolean;
  /** The calendar's database title, null when the person can no longer add to it (the link then shows no times). */
  calendar: string | null;
  createdAt: Date;
};

const urlOf = (token: string) => `${env.appUrl}/b/${token}`;

const schedulePart = (input: BookingLinkInput): BookingSchedule => ({
  timeZone: input.timeZone,
  weekdays: input.weekdays,
  startMinute: input.startMinute,
  endMinute: input.endMinute,
  durationMinutes: input.durationMinutes,
  bufferMinutes: input.bufferMinutes,
  daysAhead: input.daysAhead,
  minNoticeMinutes: input.minNoticeMinutes,
});

function checked(input: BookingLinkInput) {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title || title.length > BOOKING_LIMITS.title) throw new BookingError("invalid", "A link needs a title", "title");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > BOOKING_LIMITS.description) throw new BookingError("invalid", "The description is too long", "description");
  const problem = scheduleProblem(schedulePart(input), isTimeZone(input.timeZone));
  if (problem) throw new BookingError("invalid", `Invalid booking schedule (${problem})`, problem);
  if (typeof input.databaseId !== "string" || !input.databaseId) throw new BookingError("invalid", "A link needs a calendar", "database");
  return { ...input, title, description, weekdays: [...input.weekdays].sort((a, b) => a - b) };
}

/** The person's booking links in a workspace, oldest first. */
export async function listBookingLinks(userId: string, workspaceId: string): Promise<BookingLinkView[]> {
  await requireMembership(userId, workspaceId);
  const [rows, calendars] = await Promise.all([
    db
      .select()
      .from(bookingLink)
      .where(and(eq(bookingLink.userId, userId), eq(bookingLink.workspaceId, workspaceId)))
      .orderBy(asc(bookingLink.createdAt)),
    writableCalendars(userId, workspaceId),
  ]);
  const titles = new Map(calendars.map((c) => [c.databaseId, c.title]));
  return rows.map((row) => ({
    id: row.id,
    url: urlOf(row.token),
    enabled: row.enabled,
    calendar: titles.get(row.databaseId) ?? null,
    createdAt: row.createdAt,
    title: row.title,
    description: row.description,
    databaseId: row.databaseId,
    durationMinutes: row.durationMinutes,
    weekdays: row.weekdays,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    bufferMinutes: row.bufferMinutes,
    daysAhead: row.daysAhead,
    minNoticeMinutes: row.minNoticeMinutes,
    timeZone: row.timeZone,
  }));
}

/** The calendars a link may receive bookings in (Google calendars synced both ways the person may add to). */
export const bookingCalendars = (userId: string, workspaceId: string): Promise<WritableCalendar[]> => writableCalendars(userId, workspaceId);

async function requireCalendar(userId: string, workspaceId: string, databaseId: string) {
  if (!(await writableCalendars(userId, workspaceId)).some((c) => c.databaseId === databaseId)) {
    throw new BookingError("noCalendar", "That calendar can't take bookings", "database");
  }
}

/** Makes a link for the person; returns it. */
export async function createBookingLink(userId: string, workspaceId: string, input: BookingLinkInput): Promise<BookingLinkView> {
  await requireMembership(userId, workspaceId);
  const values = checked(input);
  await requireCalendar(userId, workspaceId, values.databaseId);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookingLink)
    .where(and(eq(bookingLink.userId, userId), eq(bookingLink.workspaceId, workspaceId)));
  if (count >= MAX_BOOKING_LINKS) throw new BookingError("tooMany", `At most ${MAX_BOOKING_LINKS} booking links`);
  const [row] = await db
    .insert(bookingLink)
    .values({ ...values, token: randomBytes(24).toString("base64url"), userId, workspaceId })
    .returning({ id: bookingLink.id });
  const created = (await listBookingLinks(userId, workspaceId)).find((l) => l.id === row.id);
  return created!;
}

/** Changes one of the person's links (all of its settings, and whether it takes bookings). */
export async function updateBookingLink(userId: string, id: string, input: BookingLinkInput & { enabled: boolean }): Promise<void> {
  const [own] = await db.select({ workspaceId: bookingLink.workspaceId, databaseId: bookingLink.databaseId }).from(bookingLink).where(and(eq(bookingLink.id, id), eq(bookingLink.userId, userId)));
  if (!own) throw new BookingError("notFound", "No such booking link");
  await requireMembership(userId, own.workspaceId);
  const values = checked(input);
  if (values.databaseId !== own.databaseId) await requireCalendar(userId, own.workspaceId, values.databaseId);
  await db
    .update(bookingLink)
    .set({ ...values, enabled: input.enabled === true })
    .where(and(eq(bookingLink.id, id), eq(bookingLink.userId, userId)));
  dropBusy(id);
}

/** Deletes one of the person's links: its address stops working at once. */
export async function deleteBookingLink(userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(bookingLink)
    .where(and(eq(bookingLink.id, id), eq(bookingLink.userId, userId)))
    .returning({ id: bookingLink.id });
  if (!deleted.length) throw new BookingError("notFound", "No such booking link");
  dropBusy(id);
}

// ---------------------------------------------------------------------------------------------
// Free time, for the AI chat

export type FreeStretch = { start: string; end: string; day: string; from: string; to: string };

/** The most stretches one read of free time lists. */
const MAX_FREE_STRETCHES = 200;
/** The longest range of days `findFreeTime` reads. */
export const FREE_TIME_MAX_DAYS = 31;

/**
 * When the person is free from `from` to `to` (YYYY-MM-DD, both included, their days in `timeZone`):
 * the stretches inside their working days and hours at least `durationMinutes` long, with `buffer`
 * kept clear of what is on their calendar (events they see, meeting notes, time planned for tasks).
 * Only times: nothing of what takes the rest. `timeZone` is the person's, whose clock the hours are.
 */
export async function findFreeTime(
  userId: string,
  workspaceId: string,
  input: Omit<BookingSchedule, "daysAhead" | "minNoticeMinutes"> & { from: string; to: string; now?: number },
): Promise<{ stretches: FreeStretch[]; truncated: boolean }> {
  const { from, to, timeZone, now = Date.now() } = input;
  const problem = scheduleProblem({ ...input, daysAhead: BOOKING_LIMITS.daysAhead.min, minNoticeMinutes: 0 }, isTimeZone(timeZone));
  if (problem) throw new BookingError("invalid", `Invalid working hours (${problem})`, problem);
  const fromDay = dayNumberOf(from);
  const toDay = dayNumberOf(to);
  if (fromDay === null || toDay === null || toDay < fromDay || toDay - fromDay >= FREE_TIME_MAX_DAYS) {
    throw new BookingError("invalid", `Give whole days, at most ${FREE_TIME_MAX_DAYS} of them, in YYYY-MM-DD`, "daysAhead");
  }
  const dates = await busyDates(userId, workspaceId, { from: dayString(fromDay - 1), to: dayString(toDay + 1), timeZone });
  const windows = workingWindows({ fromDay, toDay, weekdays: input.weekdays, startMinute: input.startMinute, endMinute: input.endMinute, timeZone }, now);
  const free = atLeastLong(takeOut(windows, busyFromDates(dates), input.bufferMinutes), input.durationMinutes);
  const clock = (instant: number) => {
    const w = wallClock(instant, timeZone);
    return { day: dayString(w.day), time: `${String(Math.floor(w.minutes / 60)).padStart(2, "0")}:${String(w.minutes % 60).padStart(2, "0")}` };
  };
  const stretches = free.slice(0, MAX_FREE_STRETCHES).map((s): FreeStretch => {
    const a = clock(s.start);
    const b = clock(s.end);
    return { start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), day: a.day, from: a.time, to: b.day === a.day ? b.time : `${b.day} ${b.time}` };
  });
  return { stretches, truncated: free.length > MAX_FREE_STRETCHES };
}

function dayNumberOf(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day ? null : Math.floor(ms / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// The public page

type OpenLink = typeof bookingLink.$inferSelect & { ownerName: string };

/** The link of an address when it is on, and its owner still may offer it; null otherwise (always the same answer). */
async function openLink(token: string): Promise<OpenLink | null> {
  if (typeof token !== "string" || !token || token.length > 128 || env.localMode) return null;
  const [row] = await db
    .select({ link: bookingLink, ownerName: user.name })
    .from(bookingLink)
    .innerJoin(user, eq(user.id, bookingLink.userId))
    .where(and(eq(bookingLink.token, token), eq(bookingLink.enabled, true)));
  if (!row) return null;
  const { link } = row;
  // The owner left the workspace or lost the calendar: the link answers as one that was never made.
  const calendars = await writableCalendars(link.userId, link.workspaceId).catch(() => []);
  if (!calendars.some((c) => c.databaseId === link.databaseId)) return null;
  return { ...link, ownerName: row.ownerName };
}

const scheduleOf = (link: typeof bookingLink.$inferSelect): BookingSchedule => ({
  timeZone: link.timeZone,
  weekdays: link.weekdays,
  startMinute: link.startMinute,
  endMinute: link.endMinute,
  durationMinutes: link.durationMinutes,
  bufferMinutes: link.bufferMinutes,
  daysAhead: link.daysAhead,
  minNoticeMinutes: link.minNoticeMinutes,
});

/** How long a link's busy times are kept for page views; booking always reads them fresh. */
const BUSY_CACHE_MS = 30_000;
const busyCache = () => ((globalThis as Record<string, unknown>).__leafdeskBookingBusy ??= new Map<string, { at: number; busy: Interval[] }>()) as Map<string, { at: number; busy: Interval[] }>;
const dropBusy = (id: string) => void busyCache().delete(id);

async function busyOf(link: typeof bookingLink.$inferSelect, now: number, fresh: boolean): Promise<Interval[]> {
  const cache = busyCache();
  const kept = cache.get(link.id);
  if (!fresh && kept && now - kept.at < BUSY_CACHE_MS) return kept.busy;
  const today = localDay(now, link.timeZone);
  const dates = await busyDates(link.userId, link.workspaceId, {
    from: dayString(today - 1),
    to: dayString(today + link.daysAhead + 1),
    timeZone: link.timeZone,
  });
  const busy = busyFromDates(dates);
  if (cache.size > 500) cache.clear();
  cache.set(link.id, { at: now, busy });
  return busy;
}

export type PublicBooking = {
  token: string;
  title: string;
  description: string;
  /** The person's name: whose time it is. */
  ownerName: string;
  durationMinutes: number;
  timeZone: string;
  /** The instants of the free slots, in order. */
  slots: number[];
};

/** Public page views per address, and per link from everyone. */
export const BOOKING_VIEW_LIMITS = { perIp: { limit: 120, windowMs: 10 * 60_000 } };
/** Bookings per address, and per link from everyone. */
export const BOOKING_RATE_LIMITS = {
  perIp: { limit: 6, windowMs: 10 * 60_000 },
  perLink: { limit: 60, windowMs: 60 * 60_000 },
};
const viewLimiter = () => sharedLimiter("booking:view", BOOKING_VIEW_LIMITS.perIp.limit, BOOKING_VIEW_LIMITS.perIp.windowMs);
const ipLimiter = () => sharedLimiter("booking:ip", BOOKING_RATE_LIMITS.perIp.limit, BOOKING_RATE_LIMITS.perIp.windowMs);
const linkLimiter = () => sharedLimiter("booking:link", BOOKING_RATE_LIMITS.perLink.limit, BOOKING_RATE_LIMITS.perLink.windowMs);

/** Scripts and tests: start counting again. */
export function resetBookingRateLimits() {
  for (const limiter of [viewLimiter, ipLimiter, linkLimiter]) limiter().reset();
  busyCache().clear();
}

/** What a link's page shows, or null when the link doesn't (or no longer) work. */
export async function getPublicBooking(token: string, { ip, now = Date.now() }: { ip: string; now?: number }): Promise<PublicBooking | null> {
  const link = await openLink(token);
  if (!link) return null;
  if (takeAll([[viewLimiter(), ipRateKey(ip)]], now) > 0) throw new BookingError("rateLimited", "Too many requests; try again later");
  const slots = bookableSlots(scheduleOf(link), await busyOf(link, now, false), now);
  return {
    token,
    title: link.title,
    description: link.description,
    ownerName: link.ownerName,
    durationMinutes: link.durationMinutes,
    timeZone: link.timeZone,
    slots,
  };
}

// A ticket proves when the page was loaded, as a public form's does (server/forms.ts).
const MIN_FILL_MS = 3000;
const MAX_TICKET_AGE_MS = 24 * 60 * 60_000;
const signTicket = (token: string, issuedAt: string) => createHmac("sha256", env.authSecret).update(`booking-ticket:${token}:${issuedAt}`).digest("base64url");

/** Proof of when the booking page was loaded, sent back with the booking. */
export function issueBookingTicket(token: string, now = Date.now()) {
  const issuedAt = String(now);
  return `${issuedAt}.${signTicket(token, issuedAt)}`;
}

function ticketAge(token: string, ticket: unknown, now: number): number | null {
  if (typeof ticket !== "string" || ticket.length > 200) return null;
  const [issuedAt, signature] = ticket.split(".");
  if (!issuedAt || !signature || !/^\d{1,16}$/.test(issuedAt)) return null;
  const expected = Buffer.from(signTicket(token, issuedAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return now - Number(issuedAt);
}

export type PublicBookingRequest = {
  /** The instant the slot starts, one of the page's `slots`. */
  start: number;
  name: string;
  email: string;
  note: string;
  ticket: string;
  /** The hidden field; people leave it empty. */
  honeypot?: string;
};

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/**
 * Books a slot: checks the link, the spam guards and the answers, then, one booking per person at
 * a time, that the slot is still free (reading the calendar afresh, so an earlier booking counts),
 * and writes it as a row of the link's calendar. Then the owner is told, and the visitor emailed
 * (a mail server that is down never undoes the booking). Returns the slot, or null when the
 * booking was quietly dropped as spam. `locale` is the visitor's.
 */
export async function bookSlot(
  token: string,
  request: PublicBookingRequest,
  { ip: address, locale, now = Date.now() }: { ip: string; locale: Locale; now?: number },
): Promise<{ start: number; end: number } | null> {
  const ip = ipRateKey(address);
  const name = typeof request.name === "string" ? request.name.replace(/\s+/g, " ").trim() : "";
  const email = typeof request.email === "string" ? request.email.trim() : "";
  const note = typeof request.note === "string" ? request.note.trim() : "";
  if (!name || name.length > BOOKING_LIMITS.name || !EMAIL.test(email) || email.length > BOOKING_LIMITS.email || note.length > BOOKING_LIMITS.note || !Number.isSafeInteger(request.start)) {
    throw new BookingError("invalidAnswers", "Check the name, the email address and the note");
  }
  const link = await openLink(token);
  if (!link) throw new BookingError("closed", "This booking link is closed");
  const age = ticketAge(token, request.ticket, now);
  if (age === null || age > MAX_TICKET_AGE_MS) throw new BookingError("expired", "The page has expired; reload it");
  if (age < MIN_FILL_MS) throw new BookingError("tooFast", "The booking was sent too quickly");
  if (takeAll([[ipLimiter(), ip], [linkLimiter(), link.id]], now) > 0) throw new BookingError("rateLimited", "Too many bookings; try again later");
  // Bots fill in every field. They are told it worked, so they have nothing to adapt to.
  if (typeof request.honeypot === "string" && request.honeypot.trim()) return null;

  const schedule = scheduleOf(link);
  const slot = slotInterval(schedule, request.start);
  const t = emailTranslator(locale);
  const description = [t("bookingEvent.by", { name, email }), ...(note ? [t("bookingEvent.note", { note })] : [])].join("\n");
  const { rowId } = await db.transaction(async (tx) => {
    // One booking of a person's calendar at a time, whichever link it came by: the next one reads
    // the calendar once this one's row is in it (the row is written outside this transaction, the
    // lock is held until it ends).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:booking:${link.userId}`}))`);
    if (!slotIsOffered(schedule, await busyOf(link, now, true), request.start, now)) throw new BookingError("slotTaken", "That time is no longer free");
    return createVisitorEvent(link.userId, link.workspaceId, link.databaseId, {
      title: `${link.title}: ${name}`,
      start: new Date(slot.start).toISOString(),
      end: new Date(slot.end).toISOString(),
      description,
    });
  });
  dropBusy(link.id);

  await tellOwner(link, rowId, name, request.start).catch((error) => console.error("could not record the booking notification", error));
  await confirmToVisitor(link, { name, email, start: slot.start, locale }).catch((error) => console.error("could not send the booking confirmation", error));
  return slot;
}

async function tellOwner(link: OpenLink, rowId: string, name: string, start: number) {
  const [inserted] = await db
    .insert(notification)
    .values({ userId: link.userId, workspaceId: link.workspaceId, kind: "booking_made", actorId: null, pageId: rowId, message: name, date: dayString(localDay(start, link.timeZone)) })
    .returning({ id: notification.id });
  signalInbox(link.workspaceId);
  pushNotifications([inserted.id]);
}

async function confirmToVisitor(link: OpenLink, visitor: { name: string; email: string; start: number; locale: Locale }) {
  const when = new Intl.DateTimeFormat(visitor.locale, { dateStyle: "full", timeStyle: "long", timeZone: link.timeZone }).format(visitor.start);
  const mail = bookingConfirmationEmail(visitor.locale, { name: visitor.name, title: link.title, owner: link.ownerName, when, minutes: link.durationMinutes });
  await sendMail({ to: visitor.email, ...mail });
}

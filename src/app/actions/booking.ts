"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { AccessError } from "@/server/access";
import * as booking from "@/server/booking";
import type { WritableCalendar } from "@/server/calendar-events";
import { requestLocale } from "@/server/mail/locale";
import { requireUserId } from "@/server/session";

// Booking links (server/booking.ts): the owner's side is managed from the Calendar place, the
// public side (`/b/<token>`) answers anyone, signed in or not.

/** Why a link couldn't be saved, as the dialog words it. */
export type BookingLinkError = "title" | "weekdays" | "hours" | "invalid" | "noCalendar" | "tooMany" | "notFound" | "failed";
export type BookingLinkResult<T> = { ok: true; data: T } | { ok: false; error: BookingLinkError };

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** The settings of a link as the dialog sent them, narrowed by hand; null when they aren't a link's at all. */
function linkInput(raw: unknown): booking.BookingLinkInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
  if (!isText(r.title, 500) || !isText(r.description, 5000) || !isId(r.databaseId) || !isText(r.timeZone, 100) || !Array.isArray(r.weekdays) || r.weekdays.length > 7) return null;
  return {
    title: r.title,
    description: r.description,
    databaseId: r.databaseId,
    timeZone: r.timeZone,
    weekdays: r.weekdays.map(whole),
    durationMinutes: whole(r.durationMinutes),
    startMinute: whole(r.startMinute),
    endMinute: whole(r.endMinute),
    bufferMinutes: whole(r.bufferMinutes),
    daysAhead: whole(r.daysAhead),
    minNoticeMinutes: whole(r.minNoticeMinutes),
  };
}

/** What the dialog says of a link's problem: the three it can name, a calendar that can't take bookings, else "check the settings". */
function invalidReason(problem: booking.BookingError["problem"]): BookingLinkError {
  if (problem === "title" || problem === "weekdays" || problem === "hours") return problem;
  return problem === "database" ? "noCalendar" : "invalid";
}

async function run<T>(work: () => Promise<T>): Promise<BookingLinkResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof booking.BookingError) {
      if (error.code === "invalid") return { ok: false, error: invalidReason(error.problem) };
      if (error.code === "noCalendar" || error.code === "tooMany" || error.code === "notFound") return { ok: false, error: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: "notFound" };
    console.error("[booking action]", error);
    return { ok: false, error: "failed" };
  }
}

/** The person's booking links in a workspace (a read, also served through /api/read). */
export async function bookingLinksAction(workspaceId: string): Promise<booking.BookingLinkView[] | null> {
  const userId = await requireUserId();
  if (!isId(workspaceId)) return null;
  return booking.listBookingLinks(userId, workspaceId).catch(() => null);
}

/** The calendars a booking link may receive bookings in (a read). */
export async function bookingCalendarsAction(workspaceId: string): Promise<WritableCalendar[] | null> {
  const userId = await requireUserId();
  if (!isId(workspaceId)) return null;
  return booking.bookingCalendars(userId, workspaceId).catch(() => null);
}

export async function createBookingLinkAction(workspaceId: string, raw: unknown) {
  const userId = await requireUserId();
  const input = linkInput(raw);
  if (!isId(workspaceId) || !input) return { ok: false, error: "failed" } as const;
  const result = await run(() => booking.createBookingLink(userId, workspaceId, input));
  revalidatePath(`/w/${workspaceId}/calendar`);
  return result;
}

export async function updateBookingLinkAction(workspaceId: string, id: string, raw: unknown, enabled: boolean) {
  const userId = await requireUserId();
  const input = linkInput(raw);
  if (!isId(workspaceId) || !isId(id) || !input || typeof enabled !== "boolean") return { ok: false, error: "failed" } as const;
  const result = await run(() => booking.updateBookingLink(userId, id, { ...input, enabled }));
  revalidatePath(`/w/${workspaceId}/calendar`);
  return result;
}

export async function deleteBookingLinkAction(workspaceId: string, id: string) {
  const userId = await requireUserId();
  if (!isId(workspaceId) || !isId(id)) return { ok: false, error: "failed" } as const;
  const result = await run(() => booking.deleteBookingLink(userId, id));
  revalidatePath(`/w/${workspaceId}/calendar`);
  return result;
}

/** Why a visit's booking failed, as the public page words it. */
export type PublicBookingError = "slotTaken" | "expired" | "tooFast" | "rateLimited" | "closed" | "invalidAnswers" | "failed";

/** Books a slot of a link (`/b/<token>`); the answer says when, nothing of the person's calendar. */
export async function bookSlotAction(
  token: string,
  request: booking.PublicBookingRequest,
): Promise<{ ok: true; data: { start: number; end: number } | null } | { ok: false; error: PublicBookingError }> {
  const [h, locale] = await Promise.all([headers(), requestLocale()]);
  try {
    // A booking quietly dropped as spam answers as one that went in.
    return { ok: true, data: await booking.bookSlot(token, request, { ip: h.get(CLIENT_IP_HEADER) ?? "unknown", locale }) };
  } catch (error) {
    if (error instanceof booking.BookingError && error.code !== "invalid" && error.code !== "notFound" && error.code !== "noCalendar" && error.code !== "tooMany") {
      return { ok: false, error: error.code };
    }
    console.error("[booking]", error);
    return { ok: false, error: "failed" };
  }
}

/** The free slots of a link now (after one was taken meanwhile); null when the link no longer works. */
export async function bookingSlotsAction(token: string): Promise<number[] | null> {
  const h = await headers();
  if (!isText(token, 128)) return null;
  const found = await booking.getPublicBooking(token, { ip: h.get(CLIENT_IP_HEADER) ?? "unknown" }).catch(() => null);
  return found?.slots ?? null;
}

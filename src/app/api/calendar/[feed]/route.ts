import { readCalendarFeed } from "@/server/calendar-feeds";

/**
 * A calendar feed (see server/calendar-feeds): `GET /api/calendar/<secret>.ics`, for calendar apps
 * subscribed to a calendar view. The secret in the address is the only credential; no cookies.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ feed: string }> }) {
  const { feed } = await params;
  const result = await readCalendarFeed(feed.replace(/\.ics$/, ""));
  if (result.status !== 200) {
    return new Response(null, { status: result.status, headers: { "Cache-Control": "no-store", ...(result.status === 429 ? { "Retry-After": "60" } : {}) } });
  }
  return new Response(result.body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="calendar.ics"; filename*=UTF-8''${encodeURIComponent(result.name)}.ics`,
      "Cache-Control": "private, no-store",
      // The secret is in the address: don't hand it on to sites the events link to.
      "Referrer-Policy": "no-referrer",
    },
  });
}

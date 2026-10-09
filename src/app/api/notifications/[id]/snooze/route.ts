import { auth } from "@/lib/auth";
import { snoozeUntil } from "@/lib/snooze";
import { isCrossSite } from "@/server/cross-site";
import { snoozeNotification } from "@/server/notifications";

/**
 * Snoozes one of the signed-in user's notifications for an hour: `POST
 * /api/notifications/<id>/snooze` with `X-Leafdesk-Snooze: 1`, sent by the service worker when the
 * Snooze button of a push notification is pressed (public/sw.js). The custom header is the CSRF
 * protection, as for /api/files: a cross-site form can't send it. A foreign Origin is refused too.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return new Response(null, { status: 401 });
  if (isCrossSite(request, "x-leafdesk-snooze")) {
    return new Response(null, { status: 403 });
  }
  const { id } = await params;
  const snoozed = await snoozeNotification(session.user.id, id, snoozeUntil("hour", new Date()));
  return new Response(null, { status: snoozed ? 204 : 404, headers: { "Cache-Control": "no-store" } });
}

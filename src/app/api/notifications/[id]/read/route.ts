import { auth } from "@/lib/auth";
import { isCrossSite } from "@/server/cross-site";
import { markNotificationRead } from "@/server/notifications";

/**
 * Marks one of the signed-in user's notifications read: `POST /api/notifications/<id>/read` with
 * `X-Leafdesk-Read: 1`, sent by the service worker when the Mark as read button of a push
 * notification is pressed (public/sw.js). Protected like the snooze route next to it: the custom
 * header is the CSRF protection, and a foreign Origin is refused too.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return new Response(null, { status: 401 });
  if (isCrossSite(request, "x-leafdesk-read")) {
    return new Response(null, { status: 403 });
  }
  const { id } = await params;
  const found = await markNotificationRead(session.user.id, id);
  return new Response(null, { status: found ? 204 : 404, headers: { "Cache-Control": "no-store" } });
}

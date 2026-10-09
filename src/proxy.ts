import { NextResponse, type NextRequest } from "next/server";

/**
 * Hands the requested path to server components (they can't read the URL themselves), so
 * `requireUser` can send people back to it after signing in. Keep the header name in sync with
 * src/server/session.ts.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const params = new URLSearchParams(request.nextUrl.search);
  params.delete("_rsc");
  const query = params.toString();
  headers.set("x-leafdesk-path", request.nextUrl.pathname + (query ? `?${query}` : ""));
  return NextResponse.next({ request: { headers } });
}

// Only the signed-in app; everything else either needs no session or has nothing worth returning to.
export const config = { matcher: ["/w/:path*", "/print/:path*", "/account", "/share"] };

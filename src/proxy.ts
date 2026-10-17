import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "@/lib/content-security-policy";

// The signed-in app; everything else either needs no session or has nothing worth returning to.
const RETURNABLE = /^\/(w|print)(\/|$)|^\/(account|share)$/;

/**
 * Every page gets its Content-Security-Policy here, with a nonce of its own (see
 * lib/content-security-policy). Next reads the policy from the request to put the nonce on its
 * scripts, so it goes on both.
 *
 * Pages of the signed-in app also get their requested path, for server components (they can't
 * read the URL themselves), so `requireUser` can send people back to it after signing in. Keep the
 * header name in sync with src/server/session.ts.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    host: request.headers.get("host") ?? "",
    dev: process.env.NODE_ENV !== "production",
  });
  headers.set("content-security-policy", policy);
  if (RETURNABLE.test(request.nextUrl.pathname)) {
    const params = new URLSearchParams(request.nextUrl.search);
    params.delete("_rsc");
    const query = params.toString();
    headers.set("x-leafdesk-path", request.nextUrl.pathname + (query ? `?${query}` : ""));
  }
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

// Pages only: not API routes and other endpoints (they set their own headers), Next's static files
// or the files in public/. No page's path starts like these.
export const config = {
  matcher: ["/((?!api/|_next/static/|_next/image|mcp|scim/|\\.well-known/|favicon\\.ico|icon\\.svg|apple-icon\\.png|sw\\.js|manifest\\.webmanifest|icons/|connections/).*)"],
};

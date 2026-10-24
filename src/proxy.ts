import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "@/lib/content-security-policy";
import { isAnalyticsId, isSiteKey, SITE_ANALYTICS_HEADER, SITE_HOST_HEADER, SITE_KEY_HEADER } from "@/lib/site";

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
 *
 * Workspace sites: on a site's own domain (server.ts says which, see server/site-hosts.ts) its
 * pages are served at the root, from `/s/<slug>`. Requests for a site's pages carry its slug for
 * the root layout (the site's theme); on its domain, with an analytics ID, the policy lets Google's tag in.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const siteHost = request.headers.get(SITE_HOST_HEADER);
  const onSiteHost = siteHost !== null && isSiteKey(siteHost);
  const { pathname, search } = request.nextUrl;
  const path = onSiteHost ? `/s/${siteHost}${pathname === "/" ? "" : pathname}` : pathname;
  const siteKey = /^\/s\/([^/]+)/.exec(path)?.[1];
  if (siteKey && isSiteKey(siteKey)) headers.set(SITE_KEY_HEADER, siteKey);
  else headers.delete(SITE_KEY_HEADER);
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    host: request.headers.get("host") ?? "",
    dev: process.env.NODE_ENV !== "production",
    // server.ts sends an analytics ID only with a page on the site's own domain.
    analytics: onSiteHost && isAnalyticsId(request.headers.get(SITE_ANALYTICS_HEADER)),
  });
  headers.set("content-security-policy", policy);
  if (!onSiteHost && RETURNABLE.test(pathname)) {
    const params = new URLSearchParams(request.nextUrl.search);
    params.delete("_rsc");
    const query = params.toString();
    headers.set("x-leafdesk-path", request.nextUrl.pathname + (query ? `?${query}` : ""));
  }
  const response = onSiteHost
    ? NextResponse.rewrite(new URL(path + search, request.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

// Pages only: not API routes and other endpoints (they set their own headers), Next's static files
// or the files in public/. No page's path starts like these (a site's page on its own domain may
// start with "mcp-", so only the MCP endpoint itself is left out).
export const config = {
  matcher: ["/((?!api/|_next/static/|_next/image|mcp(?:/|$)|scim/|\\.well-known/|favicon\\.ico|icon\\.svg|apple-icon\\.png|sw\\.js|manifest\\.webmanifest|icons/|connections/).*)"],
};

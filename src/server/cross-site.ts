import { env } from "@/lib/env";

/**
 * Whether a request to a route only the app itself calls may have come from another site: it names
 * another host as its Origin, or `header` (the route's custom header, which a cross-site form can't
 * send and a cross-site fetch can't without a preflight these routes don't answer) isn't "1".
 */
export function isCrossSite(request: Request, header?: string) {
  if (header && request.headers.get(header) !== "1") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const hosts = [new URL(env.appUrl).host, request.headers.get("x-forwarded-host"), request.headers.get("host")];
  return !hosts.includes(URL.parse(origin)?.host ?? "");
}

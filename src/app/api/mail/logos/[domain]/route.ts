import { auth } from "@/lib/auth";
import { LOGO_TYPES, logoDomain, type LogoFormat } from "@/lib/sender-marks";
import { logoKeyValid, storedLogo } from "@/server/mail-client/sender-logos";

/**
 * Serves the logo kept for a domain mail came from (server/mail-client/sender-logos.ts) to
 * the person its address was signed for (`k`), who was shown mail from that domain: the cache is
 * shared by every workspace, and which domains are in it says where mail came from. Only what the
 * background job already fetched: nothing is fetched here. The address carries when it was fetched,
 * so it can be cached long. An SVG is plain (lib/sender-marks.ts `plainSvg`), and opened at this
 * address it runs sandboxed anyway.
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

function notFound(status = 404) {
  return new Response("Not found", { status, headers: { ...HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ domain: string }> }) {
  let domain: string | null;
  try {
    domain = logoDomain(`x@${decodeURIComponent((await params).domain)}`);
  } catch {
    return notFound();
  }
  if (!domain) return notFound();
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return notFound(401);
  if (!logoKeyValid(session.user.id, domain, new URL(request.url).searchParams.get("k"))) return notFound();
  const logo = await storedLogo(domain);
  const type = logo && LOGO_TYPES[logo.type as LogoFormat];
  if (!logo || !type) return notFound();
  return new Response(Buffer.from(logo.image), { status: 200, headers: { ...HEADERS, "Content-Type": type, "Cache-Control": "private, max-age=2592000, immutable" } });
}

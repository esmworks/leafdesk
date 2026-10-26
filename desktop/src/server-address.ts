/**
 * What people type as their server's address, and what it means. Leafdesk runs at the root of its
 * host (no base path), so a server is an origin: a path someone pasted along with it is dropped.
 */

const LOOPBACK = /^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

function isLoopback(hostname: string) {
  return LOOPBACK.test(hostname);
}

/**
 * The origins to try for an address, in order, or null when it isn't one. Without a scheme HTTPS
 * comes first, then plain HTTP (a server on the local network often has no certificate); for this
 * computer itself the other way round.
 */
export function addressCandidates(input: string): string[] | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "http" && scheme !== "https") return null;
    const url = parse(text);
    return url ? [url.origin] : null;
  }
  // "host:port" alone would read as a scheme, so it always gets one here.
  const url = parse(`https://${text}`);
  if (!url) return null;
  const http = `http://${url.host}`;
  return isLoopback(url.hostname) ? [http, url.origin] : [url.origin, http];
}

function parse(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** Whether pages from this origin get a secure context: service workers and passkeys need one. */
export function isSecureOrigin(origin: string) {
  const url = parse(origin);
  if (!url) return false;
  return url.protocol === "https:" || isLoopback(url.hostname);
}

/**
 * Whether typing this address leads to plain HTTP away from this computer: only an explicit
 * `http://` does, since without a scheme HTTPS is tried first.
 */
export function warnsInsecure(input: string) {
  const text = input.trim();
  if (!/^http:\/\//i.test(text)) return false;
  const url = parse(text);
  return !!url && !isLoopback(url.hostname);
}

/**
 * Whether connecting to `origin` for the address typed takes the person's yes first: plain HTTP
 * away from this computer that they didn't type themselves (HTTPS didn't answer, and the app tried
 * HTTP next).
 */
export function needsHttpConfirmation(input: string, origin: string) {
  const url = parse(origin);
  return !!url && url.protocol === "http:" && !isLoopback(url.hostname) && !/^http:\/\//i.test(input.trim());
}

/**
 * Whether the app follows a redirect from `from` to `to` on its own while it looks for the server:
 * on the same host, to HTTPS, or to plain HTTP when it was on HTTP already or on this computer.
 * Another host, or HTTPS down to HTTP, the person confirms first.
 */
export function followsRedirect(from: string, to: string) {
  const source = parse(from);
  const target = parse(to);
  if (!source || !target || source.hostname !== target.hostname) return false;
  if (target.protocol === "https:") return true;
  return target.protocol === "http:" && (source.protocol === "http:" || isLoopback(target.hostname));
}

/** The host shown to people: name and port, without the scheme. */
export function hostOf(origin: string) {
  return parse(origin)?.host ?? origin;
}

/** Whether a web app manifest is Leafdesk's own (src/app/manifest.ts). */
export function isLeafdeskManifest(manifest: unknown) {
  return typeof manifest === "object" && manifest !== null && (manifest as { name?: unknown }).name === "Leafdesk";
}

/**
 * Same-origin path of a redirect target (absolute or relative), or null: what `?next=` and the
 * like may send people to, so a link can't send them to another site. The target is read the way
 * browsers read it, so `//evil.example` and `/\\evil.example` (a backslash counts as a slash) are
 * other sites, not paths. For the server and the browser alike (`appUrl`: the app's URL, or
 * `window.location.origin`).
 */
export function sameOriginPath(target: string | null | undefined, appUrl: string) {
  if (!target) return null;
  try {
    const base = new URL(appUrl);
    const url = new URL(target, base);
    if (url.origin !== base.origin) return null;
    const path = url.pathname + url.search;
    return path.startsWith("/") && !path.startsWith("//") ? path : null;
  } catch {
    return null;
  }
}

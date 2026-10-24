/**
 * Workspace sites (see server/site.ts): addresses and slugs. Pure helpers, shared by the server,
 * the settings form and tests.
 *
 * A site lives at `/s/<slug>` and its pages at `/s/<slug>/<title-slug>-<page id>`. Publication links
 * (`/s/<token>/…`) share the `/s/` prefix: tokens are 43 characters long, slugs at most 40, so a key
 * is always one or the other.
 */

export const SITE_SLUG_MIN = 3;
export const SITE_SLUG_MAX = 40;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Slugs that would read as part of the app or pass for someone else's: kept back so a site can't
 * look like an official page of the server.
 */
export const RESERVED_SITE_SLUGS: ReadonlySet<string> = new Set([
  "about",
  "account",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "dashboard",
  "docs",
  "download",
  "duplicate",
  "leafdesk",
  "help",
  "home",
  "invite",
  "join",
  "login",
  "logout",
  "mcp",
  "new",
  "oauth",
  "official",
  "public",
  "root",
  "security",
  "settings",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  "site",
  "sites",
  "static",
  "status",
  "support",
  "system",
  "www",
]);

export type SiteSlugProblem = "tooShort" | "tooLong" | "invalid" | "reserved";

/** Why `slug` can't be a site's slug, or null when it can. Slugs are compared lowercased. */
export function siteSlugProblem(slug: string): SiteSlugProblem | null {
  if (slug.length < SITE_SLUG_MIN) return "tooShort";
  if (slug.length > SITE_SLUG_MAX) return "tooLong";
  if (!SLUG.test(slug) || slug.includes("--")) return "invalid";
  if (RESERVED_SITE_SLUGS.has(slug)) return "reserved";
  return null;
}

/** Whether a `/s/<key>` key names a site (else it is a publication token). */
export const isSiteKey = (key: string) => key.length <= SITE_SLUG_MAX && SLUG.test(key);

/** A slug suggestion from a name: "Ayşe's Notes" → "ayses-notes". May still need checking. */
export function slugify(text: string, max = 60): string {
  const ascii = text
    .toLocaleLowerCase("en")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  return ascii
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A site page's path segment: its title as a slug, then its id; just the id for untitled pages. */
export function pageSegment(id: string, title: string): string {
  const words = slugify(title);
  return words ? `${words}-${id}` : id;
}

/** The page id in a site path segment (`<title-slug>-<id>` or a bare id), or null. */
export function pageIdFromSegment(segment: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const uuid = UUID_AT_END.exec(value);
  if (uuid) return uuid[1].toLowerCase();
  return PLAIN_ID.test(value) ? value : null;
}

/**
 * How a published page links to the pages it shows. `base` is `/s/<token>` (a publication link:
 * pages by id) or `/s/<slug>` (a site: pages by title and id), or empty for a site on its own domain
 * (pages at the root); `homeId` is the page `base` opens.
 */
export type PublishedLinks = { base: string; homeId: string; site: boolean };

export function publishedHref(links: PublishedLinks, id: string, title: string): string {
  if (id === links.homeId) return links.base || "/";
  return `${links.base}/${links.site ? pageSegment(id, title) : id}`;
}

// ---------------------------------------------------------------------------------------------
// Own domain: a site served at the root of a host name of its own (see server/site-hosts.ts).

/**
 * Set by server.ts on requests whose host is a site's own domain, to the site's slug: the proxy then
 * serves the site's pages at the root. Whatever a client sends under these names is dropped first.
 */
export const SITE_HOST_HEADER = "x-leafdesk-site-host";
/** Set by server.ts on requests for a site's pages, to the site's analytics ID: the proxy then lets Google's tag in. */
export const SITE_ANALYTICS_HEADER = "x-leafdesk-site-analytics";
/** Set by the proxy on requests for `/s/<slug>/…`, so the root layout can take the site's theme. */
export const SITE_KEY_HEADER = "x-leafdesk-site";

export type SiteDomainProblem = "domainInvalid" | "domainReserved";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host name in what someone typed as their site's domain ("https://Docs.Example.com/" →
 * "docs.example.com", international names in their ASCII form), or null when it names none.
 */
export function normalizeSiteDomain(input: string): string | null {
  const text = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  if (!text || /[/?#@\s]/.test(text)) return null;
  try {
    const host = new URL(`http://${text}`).hostname.replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Why `domain` (normalized) can't be a site's domain, or null when it can: a host name of at least
 * two labels whose last one isn't a number (no IP addresses), and never the app's own host or
 * `localhost`, which would hand the whole app to the site.
 */
export function siteDomainProblem(domain: string, appHost: string): SiteDomainProblem | null {
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    return "domainInvalid";
  }
  if (domain === appHost.toLowerCase() || domain === "localhost") return "domainReserved";
  return null;
}

/** The host a request names: its Host header lowercased, without the port or a trailing dot. */
export function requestHost(header: string | null | undefined): string {
  const host = (header ?? "").trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d*$/, "").replace(/\.$/, "");
}

/** What happens to a request on a site's own domain (see routeOnSiteHost). */
export type SiteHostRoute =
  /** One of the site's pages (or its icon): the proxy serves it from `/s/<slug>`. */
  | { kind: "site" }
  /** Next's scripts and styles, the files the pages show, the app's icons: as on any host. */
  | { kind: "pass" }
  | { kind: "redirect"; location: string }
  | { kind: "notFound" };

const ROOT_SEGMENT = /^\/([A-Za-z0-9_-]{1,200}|favicon\.svg)$/;
const FILE_PATH = /^\/api\/files\/[A-Za-z0-9_-]{1,64}(\/preview)?$/;
const APP_ICONS = new Set(["/icon.svg", "/favicon.ico", "/apple-icon.png"]);

/**
 * Where a request on a site's own domain goes. Only the published site is served there: its pages
 * at the root, read with GET. Duplicating a page needs signing in, which happens at the app's
 * address; a site address of the app (`/s/<slug>/…`) leads to the same page at the root. Anything
 * else — the app, sign-in, the API, MCP, the collaboration socket, a form — is not found, so no
 * session is ever used on a customer's host.
 */
export function routeOnSiteHost(method: string, path: string, slug: string, appUrl: string): SiteHostRoute {
  if (method !== "GET" && method !== "HEAD") return { kind: "notFound" };
  const queryAt = path.indexOf("?");
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  const search = queryAt < 0 ? "" : path.slice(queryAt);
  if (pathname.startsWith("/_next/") || FILE_PATH.test(pathname) || APP_ICONS.has(pathname)) return { kind: "pass" };
  // The MCP endpoint is a route of its own, outside the proxy that would serve the site there.
  if (pathname === "/mcp") return { kind: "notFound" };
  if (pathname === "/duplicate") return { kind: "redirect", location: `${appUrl}/s/${slug}/duplicate${search}` };
  if (pathname === "/" || ROOT_SEGMENT.test(pathname)) return { kind: "site" };
  if (pathname === `/s/${slug}` || pathname.startsWith(`/s/${slug}/`)) {
    const rest = pathname.slice(`/s/${slug}`.length) || "/";
    if (rest === "/" || (ROOT_SEGMENT.test(rest) && rest !== "/duplicate")) return { kind: "redirect", location: `${rest}${search}` };
  }
  return { kind: "notFound" };
}

// ---------------------------------------------------------------------------------------------
// Look, header, search engines and analytics

export const SITE_THEMES = ["system", "light", "dark"] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];
export const isSiteTheme = (value: unknown): value is SiteTheme =>
  typeof value === "string" && (SITE_THEMES as readonly string[]).includes(value);

/** A link in a site's header: to a page the site serves, or a web address. */
export type SiteHeaderLink = { label: string; pageId: string } | { label: string; url: string };
export const SITE_HEADER_LINKS_MAX = 6;
export const SITE_HEADER_LABEL_MAX = 40;
const URL_MAX = 2000;

/** Whether `value` is an http(s) address a header link may lead to. */
export function isWebAddress(value: string): boolean {
  if (value.length > URL_MAX) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname;
  } catch {
    return false;
  }
}

/** Header links as they are stored, or null when one isn't valid (no label, a bad address, too many). */
export function cleanHeaderLinks(value: unknown): SiteHeaderLink[] | null {
  if (!Array.isArray(value) || value.length > SITE_HEADER_LINKS_MAX) return null;
  const links: SiteHeaderLink[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const { label: rawLabel, pageId, url } = item as Record<string, unknown>;
    const label = typeof rawLabel === "string" ? rawLabel.replace(/\s+/g, " ").trim() : "";
    if (!label || label.length > SITE_HEADER_LABEL_MAX) return null;
    if (typeof pageId === "string" && url === undefined && PLAIN_ID.test(pageId)) links.push({ label, pageId });
    else if (typeof url === "string" && pageId === undefined && isWebAddress(url.trim())) links.push({ label, url: url.trim() });
    else return null;
  }
  return links;
}

/** Search descriptions: one paragraph, as long as search results show. */
export const SEARCH_DESCRIPTION_MAX = 300;
export const cleanDescription = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, SEARCH_DESCRIPTION_MAX) : "";

/** A Google Analytics 4 measurement ID: `G-` and letters or digits. */
export const isAnalyticsId = (value: unknown): value is string => typeof value === "string" && /^G-[A-Z0-9]{4,16}$/.test(value);

/**
 * The page icon as a favicon, when it is an emoji (flags, joined emoji and skin tones included);
 * null for other text, which the app's own icon stands in for.
 */
export function emojiIcon(icon: string | null | undefined): string | null {
  const text = icon?.trim() ?? "";
  if (!text || !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]+$/u.test(text)) return null;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|\u20e3/u.test(text) ? text : null;
}

/** An SVG drawing `emoji` in the middle, as a favicon. */
export function emojiFaviconSvg(emoji: string): string {
  const escaped = emoji.replace(/[<>&"']/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="76" text-anchor="middle" dominant-baseline="central">${escaped}</text></svg>`;
}

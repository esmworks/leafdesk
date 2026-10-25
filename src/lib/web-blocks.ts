/**
 * Web blocks: a bookmark (a link shown as a card with the page's title, description, image and
 * icon) and an embed (a page of an allowlisted provider in an iframe, e.g. a YouTube video).
 *
 * Like the database and content blocks, the configs are shared by the editor (React specs,
 * components/page/web-blocks.tsx) and the server (plain specs, server/web-blocks.ts); both schemas
 * must know them, or the side that doesn't drops the blocks for everyone.
 *
 * A bookmark's details are fetched once, on the server (server/link-preview.ts), and stored in the
 * block's props, so viewing a page never fetches anything; "Refresh" fetches them again. An embed
 * stores only the URL that was pasted: the iframe's address is always derived from it here, with
 * strict parsing, so no document can point an iframe anywhere outside the allowlist.
 */

import { parseWebUrl } from "./web-url";

export { displayHost, isLoneUrl, markdownLinkDestination, markdownLinkText, MAX_URL_LENGTH, parseWebUrl } from "./web-url";

/** As BlockNote's `textAlignment` (defaultProps), written out so this module needs no editor code. */
const ALIGNMENT = { default: "left", values: ["left", "center", "right", "justify"] } as const;

export const BOOKMARK_BLOCK = "bookmark";
export const WEB_EMBED_BLOCK = "webEmbed";
export type WebBlockType = typeof BOOKMARK_BLOCK | typeof WEB_EMBED_BLOCK;

export const isWebBlockType = (type: unknown): type is WebBlockType => type === BOOKMARK_BLOCK || type === WEB_EMBED_BLOCK;

export const bookmarkBlockConfig = {
  type: BOOKMARK_BLOCK,
  propSchema: {
    url: { default: "" },
    title: { default: "" },
    description: { default: "" },
    /** The page's preview image (Open Graph / Twitter card), an absolute http(s) URL. */
    image: { default: "" },
    favicon: { default: "" },
    siteName: { default: "" },
    /** When the details were fetched (ISO time); empty until they have been. */
    fetchedAt: { default: "" },
    /**
     * The card's width in percent of the column it is in (see bookmarkWidth), dragged from its edge;
     * 0 for the whole width. A share rather than pixels, so published pages and print keep it.
     */
    width: { default: 0 },
    /** Where a narrower card sits: left (where the text starts), center or right (lib/media-blocks). */
    textAlignment: ALIGNMENT,
  },
  content: "none",
} as const;

export const webEmbedBlockConfig = {
  type: WEB_EMBED_BLOCK,
  propSchema: {
    /** The URL as pasted; the iframe's address comes from `embedFor(url)`. */
    url: { default: "" },
    /** As a bookmark's: percent of the column (lib/media-blocks mediaWidth), 0 for all of it. */
    width: { default: 0 },
    textAlignment: ALIGNMENT,
  },
  content: "none",
} as const;

export type BookmarkProps = {
  url: string;
  title: string;
  description: string;
  image: string;
  favicon: string;
  siteName: string;
  fetchedAt: string;
  width: number;
};

/** The narrowest a bookmark card can be made, in percent of its column. */
export const MIN_BOOKMARK_WIDTH = 30;

/**
 * A bookmark's width as the card is drawn, in percent of its column (MIN_BOOKMARK_WIDTH to 99,
 * whole numbers), or null for the whole width: 0, 100 and up, and anything that isn't a number.
 */
export function bookmarkWidth(value: unknown): number | null {
  const width = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(width) || width <= 0 || width >= 100) return null;
  return Math.max(MIN_BOOKMARK_WIDTH, Math.round(width));
}

/** Longest URL kept in a block. */
// ---------------------------------------------------------------------------------------------
// Embeds

/** A named provider, whose links are rewritten to its player; "web" is any other site, framed as it is (embedAny). */
export type EmbedProvider = "youtube" | "vimeo" | "loom" | "figma" | "google" | "codepen" | "spotify" | "maps" | "web";

export type EmbedTarget = {
  provider: EmbedProvider;
  /** The iframe's address: on one of EMBED_FRAME_ORIGINS for a named provider, else the https address given. */
  src: string;
  /** Fixed height in pixels, or null to keep a 16:9 box. */
  height: number | null;
};

/** The origins the named providers' players are on (embedFor). */
export const EMBED_FRAME_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://www.figma.com",
  "https://docs.google.com",
  "https://codepen.io",
  "https://open.spotify.com",
  "https://www.google.com",
] as const;

/** Permissions of an embed iframe: scripts in their own origin and opening links, nothing else. */
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";
export const EMBED_ALLOW = "encrypted-media; fullscreen; picture-in-picture";
/**
 * Only this app's origin goes to the provider (never the page's path). YouTube refuses to play
 * without a referrer, so "no-referrer" is not an option for iframes.
 */
export const EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin" as const;

const hostIs = (url: URL, ...hosts: string[]) => hosts.includes(url.hostname.toLowerCase());
const segments = (url: URL) => url.pathname.split("/").filter(Boolean);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,64}$/;

/** "90", "90s", "1m30s", "1h2m3s" → seconds, or null. */
function youtubeStart(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{1,6}$/.test(value)) return Number(value);
  const match = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(value);
  if (!match || !match[0]) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function youtube(url: URL): EmbedTarget | null {
  const parts = segments(url);
  let id: string | null = null;
  if (hostIs(url, "youtu.be")) {
    if (parts.length !== 1) return null;
    id = parts[0];
  } else if (hostIs(url, "youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com")) {
    if (parts[0] === "watch" && parts.length === 1) id = url.searchParams.get("v");
    else if (["embed", "shorts", "live", "v"].includes(parts[0]) && parts.length === 2) id = parts[1];
    else if (parts[0] === "playlist" && parts.length === 1) id = null;
    else return null;
  } else {
    return null;
  }
  const params = new URLSearchParams();
  const list = url.searchParams.get("list");
  const start = youtubeStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  if (start) params.set("start", String(start));
  if (id && YOUTUBE_ID.test(id)) {
    const query = params.toString();
    return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}${query ? `?${query}` : ""}`, height: null };
  }
  if (!id && list && YOUTUBE_LIST.test(list)) {
    return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`, height: null };
  }
  return null;
}

function vimeo(url: URL): EmbedTarget | null {
  const parts = segments(url);
  let id: string | undefined;
  let hash = url.searchParams.get("h") ?? undefined;
  if (hostIs(url, "player.vimeo.com")) {
    if (parts[0] !== "video" || parts.length !== 2) return null;
    id = parts[1];
  } else if (hostIs(url, "vimeo.com", "www.vimeo.com")) {
    // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, vimeo.com/groups/x/videos/123
    const at = parts.findIndex((p) => /^\d+$/.test(p));
    if (at < 0) return null;
    const prefix = parts.slice(0, at);
    const ok =
      prefix.length === 0 ||
      (prefix.length === 2 && prefix[0] === "channels") ||
      (prefix.length === 3 && prefix[0] === "groups" && prefix[2] === "videos") ||
      (prefix.length === 2 && prefix[0] === "showcase") ||
      (prefix.length === 3 && prefix[0] === "showcase" && prefix[2] === "video");
    if (!ok || parts.length > at + 2) return null;
    id = parts[at];
    if (parts[at + 1]) hash = parts[at + 1];
  } else {
    return null;
  }
  if (!id || !/^\d{1,12}$/.test(id)) return null;
  const params = new URLSearchParams({ dnt: "1" });
  if (hash) {
    if (!/^[a-f0-9]{6,32}$/i.test(hash)) return null;
    params.set("h", hash);
  }
  return { provider: "vimeo", src: `https://player.vimeo.com/video/${id}?${params}`, height: null };
}

function loom(url: URL): EmbedTarget | null {
  if (!hostIs(url, "loom.com", "www.loom.com")) return null;
  const parts = segments(url);
  if (parts.length !== 2 || (parts[0] !== "share" && parts[0] !== "embed")) return null;
  if (!/^[a-f0-9]{32}$/i.test(parts[1])) return null;
  return { provider: "loom", src: `https://www.loom.com/embed/${parts[1]}`, height: null };
}

const FIGMA_KINDS = new Set(["file", "design", "proto", "board", "slides", "deck"]);

function figma(url: URL): EmbedTarget | null {
  if (!hostIs(url, "figma.com", "www.figma.com")) return null;
  const parts = segments(url);
  if (parts.length < 2 || !FIGMA_KINDS.has(parts[0]) || !/^[A-Za-z0-9]{10,128}$/.test(parts[1])) return null;
  // Figma's embed page takes the file's URL; ours is rebuilt from the parts we checked.
  const file = new URL(`https://www.figma.com/${parts[0]}/${parts[1]}`);
  const node = url.searchParams.get("node-id");
  if (node && /^[\w:-]{1,64}$/.test(node)) file.searchParams.set("node-id", node);
  const params = new URLSearchParams({ embed_host: "leafdesk", url: file.href });
  return { provider: "figma", src: `https://www.figma.com/embed?${params}`, height: 450 };
}

const GOOGLE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** Published Google Docs, Sheets and Slides, and their embed URLs. Private edit links don't embed. */
function google(url: URL): EmbedTarget | null {
  if (!hostIs(url, "docs.google.com")) return null;
  const parts = segments(url);
  const kind = parts[0];
  if (kind !== "document" && kind !== "spreadsheets" && kind !== "presentation") return null;
  if (parts[1] !== "d") return null;
  const published = parts[2] === "e";
  const id = published ? parts[3] : parts[2];
  const action = published ? parts[4] : parts[3];
  if (!id || !GOOGLE_ID.test(id) || parts.length !== (published ? 5 : 4)) return null;
  const base = `https://docs.google.com/${kind}/d/${published ? "e/" : ""}${id}`;
  if (kind === "document") {
    if (published && action === "pub") return { provider: "google", src: `${base}/pub?embedded=true`, height: 600 };
    if (!published && action === "preview") return { provider: "google", src: `${base}/preview`, height: 600 };
    return null;
  }
  if (kind === "spreadsheets") {
    if (published && (action === "pubhtml" || action === "pub")) {
      const params = new URLSearchParams({ widget: "true", headers: "false" });
      const gid = url.searchParams.get("gid");
      if (gid && /^\d{1,12}$/.test(gid)) params.set("gid", gid);
      return { provider: "google", src: `${base}/pubhtml?${params}`, height: 500 };
    }
    if (!published && action === "preview") return { provider: "google", src: `${base}/preview`, height: 500 };
    return null;
  }
  if (action === "embed" || (published && action === "pub")) {
    return { provider: "google", src: `${base}/embed?start=false&loop=false`, height: null };
  }
  return null;
}

function codepen(url: URL): EmbedTarget | null {
  if (!hostIs(url, "codepen.io")) return null;
  const parts = segments(url);
  if (parts.length !== 3 || !["pen", "full", "details", "embed", "debug"].includes(parts[1])) return null;
  const [user, , slug] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(user) || !/^[A-Za-z0-9]{3,32}$/.test(slug)) return null;
  return { provider: "codepen", src: `https://codepen.io/${user}/embed/${slug}?default-tab=result`, height: 400 };
}

const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "show", "artist"]);

function spotify(url: URL): EmbedTarget | null {
  if (!hostIs(url, "open.spotify.com")) return null;
  let parts = segments(url);
  if (parts[0] === "embed") parts = parts.slice(1);
  if (parts[0] && /^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0])) parts = parts.slice(1);
  if (parts.length !== 2 || !SPOTIFY_KINDS.has(parts[0]) || !/^[A-Za-z0-9]{22}$/.test(parts[1])) return null;
  const small = parts[0] === "track" || parts[0] === "episode";
  return { provider: "spotify", src: `https://open.spotify.com/embed/${parts[0]}/${parts[1]}`, height: small ? 152 : 352 };
}

const COORDINATE = /^@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,(\d{1,2}(?:\.\d+)?)z)?/;

function maps(url: URL): EmbedTarget | null {
  const onGoogle = hostIs(url, "google.com", "www.google.com");
  if (!onGoogle && !hostIs(url, "maps.google.com")) return null;
  const parts = segments(url);
  const rest = onGoogle ? (parts[0] === "maps" ? parts.slice(1) : null) : parts;
  if (!rest) return null;
  // An embed URL copied from "Share → Embed a map".
  if (rest[0] === "embed" && rest.length === 1) {
    const pb = url.searchParams.get("pb");
    if (!pb || !/^[\w!.:%*,+-]{1,4000}$/.test(pb)) return null;
    return { provider: "maps", src: `https://www.google.com/maps/embed?${new URLSearchParams({ pb })}`, height: 450 };
  }
  let query = url.searchParams.get("q") ?? "";
  let zoom: string | null = null;
  if (rest[0] === "place" && rest[1]) {
    try {
      query = decodeURIComponent(rest[1].replace(/\+/g, " "));
    } catch {
      return null;
    }
    const at = rest.find((p) => p.startsWith("@"));
    zoom = at ? (COORDINATE.exec(at)?.[3] ?? null) : null;
  } else if (rest[0]?.startsWith("@")) {
    const match = COORDINATE.exec(rest[0]);
    if (!match) return null;
    query = `${match[1]},${match[2]}`;
    zoom = match[3] ?? null;
  } else if (rest.length !== 0 || !query) {
    return null;
  }
  query = query.trim();
  if (!query || query.length > 300) return null;
  const params = new URLSearchParams({ q: query, output: "embed" });
  if (zoom) params.set("z", String(Math.round(Number(zoom))));
  return { provider: "maps", src: `https://www.google.com/maps?${params}`, height: 450 };
}

const PROVIDERS = [youtube, vimeo, loom, figma, google, codepen, spotify, maps];

/** The iframe for a pasted URL when it belongs to a named provider, else null (a pasted link then offers a bookmark). */
export function embedFor(input: unknown): EmbedTarget | null {
  const url = parseWebUrl(input);
  if (!url) return null;
  for (const provider of PROVIDERS) {
    const target = provider(url);
    if (target) return target;
  }
  return null;
}

/** Height of a frame of any other site, which says nothing about its size. */
const WEB_EMBED_HEIGHT = 500;

/**
 * The iframe of an embed block: a named provider's player, or any other https site framed as it
 * is (Hex apps, Deepnote blocks, Pitch presentations and the like), never this app's own pages
 * (`appOrigin`). A site that refuses to be framed shows as an empty frame with its link under it.
 * The frame keeps the site in its own origin (EMBED_SANDBOX), apart from this app's cookies.
 */
export function embedAny(input: unknown, appOrigin: string): EmbedTarget | null {
  const named = embedFor(input);
  if (named) return named;
  const url = parseWebUrl(input);
  if (!url || url.protocol !== "https:" || url.origin === appOrigin) return null;
  return { provider: "web", src: url.href, height: WEB_EMBED_HEIGHT };
}

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * In Markdown a bookmark is a plain link on a line of its own, `[Title](url)`, which every
 * renderer shows as a link; an embed is its link and a marker, `[url](url) <!-- leafdesk:embed -->`
 * (see lib/content-markdown). A link line reads back as an ordinary link, except where the page
 * already has a bookmark of that URL: see restoreBookmarks. `<!-- leafdesk:bookmark -->` after a
 * link makes a new bookmark, whose details the editor fetches when someone who may edit opens it.
 */

type AnyBlock = { type: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] };
type LinkNode = { type?: string; href?: unknown; content?: unknown };

/** The URL of a paragraph that holds nothing but one link (spaces around it aside), or null. */
function loneLinkUrl(block: AnyBlock): string | null {
  if (block.type !== "paragraph" || !Array.isArray(block.content)) return null;
  const nodes = (block.content as { type?: string; text?: string }[]).filter(
    (node) => !(node?.type === "text" && typeof node.text === "string" && !node.text.trim()),
  );
  if (nodes.length !== 1 || (nodes[0] as LinkNode).type !== "link") return null;
  return parseWebUrl((nodes[0] as LinkNode).href)?.href ?? null;
}

function collectBookmarks(blocks: readonly AnyBlock[], out: AnyBlock[] = []): AnyBlock[] {
  for (const block of blocks) {
    if (block.type === BOOKMARK_BLOCK) out.push(block);
    if (block.children?.length) collectBookmarks(block.children, out);
  }
  return out;
}

/**
 * Markdown written back into a page (MCP reads a page, edits it and writes it again) turns the
 * page's bookmarks into link lines. This turns each link line whose URL was a bookmark of the page
 * back into that bookmark, with the details it had, in order and each bookmark once. Other link
 * lines stay links: a page without bookmarks reads Markdown exactly as before.
 */
export function restoreBookmarks<B extends AnyBlock>(blocks: B[], existing: readonly AnyBlock[]): B[] {
  const available = collectBookmarks(existing).map((block) => ({ block, url: parseWebUrl(block.props?.url)?.href ?? null }));
  if (!available.length) return blocks;
  const walk = (list: B[]): B[] =>
    list.map((block) => {
      const children = block.children?.length ? walk(block.children as B[]) : block.children;
      const url = loneLinkUrl(block);
      const at = url ? available.findIndex((b) => b.url === url) : -1;
      if (at < 0) return children === block.children ? block : ({ ...block, children } as B);
      const [match] = available.splice(at, 1);
      return { type: BOOKMARK_BLOCK, props: { ...match.block.props }, children: children ?? [] } as unknown as B;
    });
  return walk(blocks);
}

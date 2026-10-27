/**
 * Blocks a model writes into a page (an agent's run, the AI chat) that would load a web address as
 * soon as someone sees the page: images, video and audio in every reader's browser, a site framed
 * by an embed, and a new bookmark, whose details the server fetches when someone who may edit opens
 * it. A model steered by what it read (a web page, a row a form or an email filled) could put what
 * it read in such an address and have it sent out without anyone clicking anything, past the
 * checks web calls get (lib/web-calls). Such blocks become links, which load only when clicked.
 * Addresses the page already loaded stay as they are: a rewrite carries the page's own media over.
 */

import { BOOKMARK_BLOCK, WEB_EMBED_BLOCK } from "./web-blocks";
import { parseWebUrl } from "./web-url";

type AnyBlock = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] };

/** Block types that load their `url` when shown. */
const LOADING = new Set(["image", "video", "audio", WEB_EMBED_BLOCK, BOOKMARK_BLOCK]);

/**
 * Where `url` would be loaded from, when that is anywhere but this app (`appOrigin`): null for
 * this app's own addresses (`/api/files/<id>`) and for data that needs no request (`data:`, `blob:`).
 */
function elsewhere(url: unknown, appOrigin: string): URL | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const value = url.trim();
  if (/^(?:data|blob):/i.test(value)) return null;
  // A host name without its scheme is read as a web address, as the editor reads it.
  const web = parseWebUrl(value);
  if (web) return web.origin === appOrigin ? null : web;
  try {
    // Resolved as the browser resolves it: `//host/x` is another site, `/api/files/x` this one.
    // Other schemes load nothing over the web and never become a link's address.
    const resolved = new URL(value, appOrigin);
    return /^https?:$/.test(resolved.protocol) && resolved.origin !== appOrigin ? resolved : null;
  } catch {
    return null;
  }
}

/** An address as `elsewhere` reads it, for telling whether the page already loaded it. */
const urlKey = (url: string) => parseWebUrl(url.trim())?.href ?? url.trim();

function loadedUrls(blocks: readonly AnyBlock[], out = new Set<string>()): Set<string> {
  for (const block of blocks) {
    const url = block.props?.url;
    if (LOADING.has(block.type) && typeof url === "string" && url.trim()) out.add(urlKey(url));
    if (block.children?.length) loadedUrls(block.children, out);
  }
  return out;
}

/** What a link standing for `block` reads as: its caption, title or file name, else its address. */
function linkText(block: AnyBlock, href: string): string {
  for (const key of ["caption", "title", "name"]) {
    const value = block.props?.[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return href;
}

/**
 * `blocks` with every block that would load an address outside this app, and not one `existing`
 * (the page as it was) already loads, turned into a paragraph holding a link to it. Its nested
 * blocks stay under it. Returns `blocks` itself when nothing changes.
 */
export function mediaAsLinks<B extends AnyBlock>(blocks: B[], existing: readonly AnyBlock[], appOrigin: string): B[] {
  const kept = loadedUrls(existing);
  let changed = false;
  const walk = (list: B[]): B[] =>
    list.map((block) => {
      const children = block.children?.length ? walk(block.children as B[]) : block.children;
      const url = block.props?.url;
      const target = LOADING.has(block.type) && !(typeof url === "string" && kept.has(urlKey(url))) ? elsewhere(url, appOrigin) : null;
      if (!target) return children === block.children ? block : ({ ...block, children } as B);
      changed = true;
      return {
        ...(block.id ? { id: block.id } : {}),
        type: "paragraph",
        props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
        content: [{ type: "link", href: target.href, content: [{ type: "text", text: linkText(block, target.href), styles: {} }] }],
        children: children ?? [],
      } as unknown as B;
    });
  const next = walk(blocks);
  return changed ? next : blocks;
}

/**
 * The web links a message's words hold, for the previews under it (server/messages/link-previews.ts).
 * Pure, and linear in the length of the words: a message may be 40,000 characters, so nothing here
 * retries a pattern against what follows it.
 */

import type { MessagePreview } from "./messages";

/** Previews under one message at most. */
export const MAX_MESSAGE_PREVIEWS = 3;

/** Characters a bare address ends at. */
const STOP = /[\s<>"'`()[\]{}|\\^]/;
/** Punctuation that ends a sentence rather than the address it follows. */
const TRAILING = /[.,;:!?*_~]+$/;

/** The parts of `body` outside code: fenced blocks first, then inline code spans. */
function outsideCode(body: string): string[] {
  const parts: string[] = [];
  body.split("```").forEach((fenced, i) => {
    if (i % 2) return;
    fenced.split("`").forEach((part, j) => {
      if (j % 2 === 0) parts.push(part);
    });
  });
  return parts;
}

/**
 * The http and https addresses in `body`, in the order they appear, each once, leaving out those in
 * code, those written `<https://…>` (kept from showing a preview, as in other chat apps) and those
 * `skip` says no to (this app's own pages, which show as mentions). At most `max`.
 */
export function messageLinks(body: string, skip: (url: URL) => boolean = () => false, max = MAX_MESSAGE_PREVIEWS): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of outsideCode(body)) {
    let from = 0;
    while (found.length < max) {
      const at = nextLinkStart(part, from);
      if (at < 0) break;
      let end = at;
      while (end < part.length && !STOP.test(part[end])) end++;
      from = end;
      if (part[at - 1] === "<") continue;
      const text = part.slice(at, end).replace(TRAILING, "");
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        continue;
      }
      if (!url.hostname.includes(".") || url.username || url.password || skip(url)) continue;
      const href = url.href;
      if (seen.has(href)) continue;
      seen.add(href);
      found.push(href);
    }
    if (found.length >= max) break;
  }
  return found;
}

/** Where the next `http://` or `https://` starts in `text` at or after `from`, or -1. */
function nextLinkStart(text: string, from: number): number {
  for (let i = text.indexOf("http", from); i >= 0; i = text.indexOf("http", i + 4)) {
    const rest = text.slice(i + 4, i + 8);
    if (rest.startsWith("://") || rest.startsWith("s://")) {
      // Inside a word ("xhttp://") it's not an address of its own.
      if (i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) continue;
      return i;
    }
  }
  return -1;
}

/** Whether a stored preview has anything to show beyond its address. */
export function previewWorthShowing(p: Pick<MessagePreview, "title" | "image" | "siteName" | "description">): boolean {
  return Boolean(p.title || p.image || p.siteName || p.description);
}

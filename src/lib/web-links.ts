/**
 * Web links that stopped working (server/web-links.ts checks them, the workspace check lists them):
 * which addresses of a page are checked, how an answer is read, and when an address counts as
 * broken. Pure, shared by the server and the browser.
 *
 * Only an answer that says so makes a link broken at once (404 Not Found, 410 Gone). A site that
 * can't be reached, has no address any more or answers with a server error may just be down for a
 * while: it is listed once it failed UNREACHABLE_FAILURES checks in a row, a day or more apart.
 * Answers that only refuse the checker (401, 403, 429 and other client errors) count as working.
 */

/** pending: not fetched yet; skipped: an address the server doesn't fetch (a private one, say). */
export type WebLinkStatus = "pending" | "ok" | "broken" | "unreachable" | "skipped";

/** notFound: 404; gone: 410; noHost: the site's name has no address; serverError: 5xx; unreachable: no answer. */
export type WebLinkReason = "notFound" | "gone" | "noHost" | "serverError" | "unreachable";

export type WebLinkResult = { status: WebLinkStatus; httpStatus: number | null; reason: WebLinkReason | null };

/** Checks in a row a site must fail without an answer (or with a server error) to be listed. */
export const UNREACHABLE_FAILURES = 3;
/** Addresses one workspace check asks about at most (of the pages edited last). */
export const MAX_WEB_LINKS = 2000;
/** The longest address checked. */
export const MAX_WEB_LINK_LENGTH = 2048;
/** An address no workspace check asked about for this long is forgotten. */
export const WEB_LINK_FORGET_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a result stands before the address is fetched again. */
export function recheckAfterMs(status: WebLinkStatus): number {
  if (status === "ok") return 7 * DAY_MS;
  if (status === "broken") return 3 * DAY_MS;
  if (status === "skipped") return 30 * DAY_MS;
  return DAY_MS;
}

/** What an HTTP answer says about a link. */
export function classifyAnswer(httpStatus: number): WebLinkResult {
  if (httpStatus === 404) return { status: "broken", httpStatus, reason: "notFound" };
  if (httpStatus === 410) return { status: "broken", httpStatus, reason: "gone" };
  if (httpStatus >= 500) return { status: "unreachable", httpStatus, reason: "serverError" };
  return { status: "ok", httpStatus, reason: null };
}

/** What a fetch that got no answer says, by its error code: a name without an address, or nothing reached. */
export function classifyFailure(code: string | undefined): WebLinkResult {
  if (code === "ENOTFOUND") return { status: "unreachable", httpStatus: null, reason: "noHost" };
  return { status: "unreachable", httpStatus: null, reason: "unreachable" };
}

/** Whether a stored result is listed as a broken link. */
export function isReported(row: { status: WebLinkStatus; failures: number }): boolean {
  return row.status === "broken" || (row.status === "unreachable" && row.failures >= UNREACHABLE_FAILURES);
}

/**
 * The address as checked and stored: http or https, without credentials or the part after `#`
 * (the same page), at most MAX_WEB_LINK_LENGTH long. Null for anything else.
 */
export function normalizeWebLink(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  url.hash = "";
  return url.href.length > MAX_WEB_LINK_LENGTH ? null : url.href;
}

/** `markdown` without its fenced code blocks (an unclosed one runs to the end). */
function withoutFences(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opens = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (opens && opens[0] === fence[0] && opens.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
    } else if (opens) fence = opens;
    else out.push(line);
  }
  return out.join("\n");
}

/** Characters a bare address doesn't end with: they close the sentence around it. */
const TRAILING = /[.,;:!?'"’”)\]}>*_~]+$/;

/**
 * The web addresses a page's Markdown links to, each once: links (`[text](https://…)`),
 * autolinks (`<https://…>`) and bare addresses, bookmarks and embeds included (they are links in
 * Markdown). Images and code are left out: an image that stops loading shows on the page itself,
 * and addresses in code are examples more often than links.
 */
export function markdownWebLinks(markdown: string): string[] {
  const text = withoutFences(markdown).replace(/`[^`\n]*`/g, " ");
  const found: string[] = [];
  const add = (raw: string) => {
    const url = normalizeWebLink(raw);
    if (url && !found.includes(url)) found.push(url);
  };
  // Images first, taken out so their addresses aren't read as bare ones.
  const withoutImages = text.replace(/!\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, " ");
  const withoutLinks = withoutImages.replace(/\[[^\]]*\]\(\s*<?(https?:\/\/(?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/gi, (_, url: string) => {
    add(url);
    return " ";
  });
  const withoutAutolinks = withoutLinks.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_, url: string) => {
    add(url);
    return " ";
  });
  for (const m of withoutAutolinks.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = m[0];
    // A closing parenthesis belongs to the address only when it opened one too (Wikipedia's).
    for (;;) {
      const trimmed = url.replace(TRAILING, "");
      if (trimmed === url) break;
      const kept = url.slice(0, trimmed.length + 1);
      if (kept.endsWith(")") && (kept.match(/\(/g)?.length ?? 0) >= (kept.match(/\)/g)?.length ?? 0)) {
        url = kept;
        break;
      }
      url = trimmed;
    }
    add(url);
  }
  return found;
}

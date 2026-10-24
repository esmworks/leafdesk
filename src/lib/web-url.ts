/**
 * Web addresses as people type and paste them, and as Markdown links write them: the small part of
 * lib/web-blocks that mentions and comments need too, apart so they don't carry the embeds along.
 */

export const MAX_URL_LENGTH = 2048;

/**
 * An http(s) URL typed or pasted by someone, normalized, or null. A bare domain ("example.com/a")
 * gets https://. URLs with a user name or password are refused: they are a phishing trick and
 * nothing a card should show.
 */
export function parseWebUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > MAX_URL_LENGTH || /\s/.test(value)) return null;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    // Only something that looks like a host name gets a scheme ("foo" or "a:b" stay no URL).
    if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(value)) return null;
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.href.length > MAX_URL_LENGTH) return null;
  return url;
}

/** Whether `text` is exactly one web URL (with a scheme), e.g. what was pasted. */
export function isLoneUrl(text: string): boolean {
  const value = text.trim();
  return /^https?:\/\/\S+$/i.test(value) && parseWebUrl(value) !== null;
}

/** The host a card shows, without "www.". */
export function displayHost(url: string): string {
  const parsed = parseWebUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, "") : url;
}

/** Text of a Markdown link, escaped so it stays one link's text. */
export function markdownLinkText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\[\]*_`<>$]/g, (c) => `\\${c}`);
}

/** A link destination; angle brackets when it has characters a bare one can't. */
export function markdownLinkDestination(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>\s]/g, encodeURIComponent)}>` : href;
}

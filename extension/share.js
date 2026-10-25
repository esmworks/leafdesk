/**
 * What the extension opens: Leafdesk's quick note (`/share` on the person's own Leafdesk) with the
 * address, title and selected text of what is saved, as the bookmarklet in Leafdesk's import
 * dialog does. Saving happens there, signed in as the person, where they pick where it goes or
 * save the whole page. Nothing is sent anywhere else.
 */

/** Selected text passed along at most (the quick note keeps it as a quote). */
export const MAX_TEXT = 2000;

/**
 * A Leafdesk address as typed (`leafdesk.example.com`, `https://…/` with or without a path) as its
 * base, without a trailing slash: https unless http is written out. Null when it isn't one.
 */
export function normalizeAddress(value) {
  const typed = String(value ?? "").trim();
  if (!typed) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/share$/, "");
  return `${url.origin}${path}`;
}

/** The quick note address on `base` (see normalizeAddress) for a page or link and the text selected on it. */
export function shareUrl(base, { url = "", title = "", text = "" }) {
  const params = new URLSearchParams();
  if (url) params.set("url", url);
  if (title) params.set("title", title.trim().slice(0, 500));
  const selected = String(text ?? "").trim().slice(0, MAX_TEXT);
  if (selected) params.set("text", selected);
  return `${base}/share?${params}`;
}

/**
 * What another app shared to Leafdesk (see app/api/share), carried in a short-lived cookie to the
 * quick note page (app/share), which fills its fields with it and drops the cookie.
 */
export const SHARED_COOKIE = "leafdesk-shared";

/** The cookie's path: only the quick note page gets it. */
export const SHARED_COOKIE_PATH = "/share";

export type SharedNote = { title: string; text: string; url: string };

/** Most bytes of the cookie's value: a cookie holds about 4 KB with its name and attributes. */
const MAX_VALUE = 3_600;

const encode = (note: SharedNote) => Buffer.from(JSON.stringify(note)).toString("base64url");

/** Cuts `text` to about four fifths, marked with "…"; empty once nothing is left. */
const shorten = (text: string) => `${text.slice(0, Math.floor(text.length * 0.8)).trimEnd()}…`.replace(/^…$/, "");

/**
 * The cookie value for `note`, within MAX_VALUE: a text too long for it is cut first, then the
 * title, and a url that still doesn't fit is dropped.
 */
export function encodeSharedNote(note: SharedNote): string {
  const { url } = note;
  let { title, text } = note;
  let value = encode({ title, text, url });
  while (value.length > MAX_VALUE && text) value = encode({ title, text: (text = shorten(text)), url });
  while (value.length > MAX_VALUE && title) value = encode({ title: (title = shorten(title)), text, url });
  if (value.length > MAX_VALUE) value = encode({ title, text, url: "" });
  return value;
}

/** What a cookie value holds, or null when it isn't one of encodeSharedNote's. */
export function decodeSharedNote(value: string | undefined): SharedNote | null {
  if (!value) return null;
  try {
    const note = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SharedNote>;
    const field = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return { title: field(note.title), text: field(note.text), url: field(note.url) };
  } catch {
    return null;
  }
}

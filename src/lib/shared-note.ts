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

/** The cookie value for `note`; a text too long for it is cut (and a url too long, dropped). */
export function encodeSharedNote(note: SharedNote): string {
  let { title, text, url } = note;
  title = title.slice(0, 500);
  if (url.length > 2_000) url = "";
  let value = encode({ title, text, url });
  while (value.length > MAX_VALUE && text) {
    text = `${text.slice(0, Math.floor(text.length * 0.8)).trimEnd()}…`.replace(/^…$/, "");
    value = encode({ title, text, url });
  }
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

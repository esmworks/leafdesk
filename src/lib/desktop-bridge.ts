/**
 * The bridge between the server and a person's desktop app (server/desktop-bridge/, and the app's
 * desktop/src/agent-files.ts, which keeps its own copy of these rules): the messages each side
 * sends, how a file's place is written, and the limits. Pure, for both the server and tests.
 *
 * The app connects to `DESKTOP_BRIDGE_PATH` with its session's cookie and announces the folders the
 * person allowed, by label only (`hello`); the server then asks it to list, read, write or trash
 * (`call`, answered by `result`) for agents' chat runs of that person. A place is
 * `<folder label>/<path inside it>`: the server never sends one outside the announced folders,
 * and the app checks every place again against the folders it keeps itself.
 */

export const DESKTOP_BRIDGE_PATH = "/desktop-bridge";
/**
 * A header the app sends with its upgrade request: a page in a browser can't set one on a
 * websocket, so no website opens the bridge with the person's cookie.
 */
export const DESKTOP_BRIDGE_HEADER = "x-leafdesk-desktop";

export const DESKTOP_OPS = ["list", "read", "write", "trash"] as const;
export type DesktopOp = (typeof DESKTOP_OPS)[number];

/** The most a file read or written may have, in bytes. */
export const MAX_LOCAL_FILE_BYTES = 512 * 1024;
/** The most entries a folder's listing has; the rest are left out (`truncated`). */
export const MAX_LOCAL_LIST_ENTRIES = 500;
/** The most folders the app may announce. */
export const MAX_LOCAL_FOLDERS = 20;
const MAX_LABEL = 100;
const MAX_PLACE = 1_000;

/** How long a list or a read may take on the computer. */
export const DESKTOP_READ_TIMEOUT_MS = 30_000;
/** How long the person has to answer a write or a trash on their computer; the app says no after it. */
export const DESKTOP_APPROVAL_MS = 2 * 60_000;
/** How long the server waits for a write or a trash: the app's own answer normally comes first. */
export const DESKTOP_CHANGE_TIMEOUT_MS = DESKTOP_APPROVAL_MS + 10_000;
/** How often the server pings a connected app; one silent for two of these is dropped. */
export const DESKTOP_PING_MS = 30_000;

/**
 * Why a call didn't happen, as the app answers it (`denied`: the person said no; `unanswered`: no
 * one answered in time; `outside`: the place leaves its folder; `protected`: a credential place
 * inside one, like `.ssh` or an `.env` file) or as the server knows it (`offline`: no app, or it
 * closed during the call; `timeout`: no answer in time).
 */
export const DESKTOP_ERRORS = [
  "denied",
  "unanswered",
  "notFound",
  "outside",
  "protected",
  "tooLarge",
  "binary",
  "notFile",
  "notFolder",
  "failed",
  "offline",
  "timeout",
] as const;
export type DesktopError = (typeof DESKTOP_ERRORS)[number];

/** A folder's entry as the app lists it: sizes in bytes, `modified` as ISO. */
export type DesktopEntry = { name: string; kind: "file" | "folder" | "link" | "other"; size: number; modified: string };

export type DesktopResult =
  | { op: "list"; entries: DesktopEntry[]; truncated: boolean }
  | { op: "read"; text: string; bytes: number }
  | { op: "write"; bytes: number; created: boolean }
  | { op: "trash" };

/** What the server asks the app; `agent` and `workspace` are names, for the question it asks the person. */
export type DesktopCall = { type: "call"; id: string; op: DesktopOp; path: string; content?: string; agent: string; workspace: string };
export type ServerMessage = DesktopCall | { type: "ping" };

export type DesktopMessage =
  | { type: "hello"; version: string; folders: string[] }
  | { type: "pong" }
  | { type: "result"; id: string; ok: true; result: DesktopResult }
  | { type: "result"; id: string; ok: false; error: DesktopError };

/** Whether a folder's label is one the app may announce: a name of its own, never a path. */
export function isFolderLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LABEL &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/** A file's place, checked: the folder's label, the path's parts inside it, and both written as one. */
export type LocalPlace = { folder: string; parts: string[]; path: string };

/**
 * A place an agent gave, checked against the folders the app announced: `<label>/<path>`, with
 * `.` and empty parts dropped. A `..` part, a backslash (a separator on Windows), a control
 * character or an unknown folder is refused, so nothing sent to the app names a place outside.
 */
export function localPlace(raw: unknown, folders: readonly string[]): LocalPlace | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Give the path as <folder>/<path inside it>." };
  if (raw.length > MAX_PLACE) return { error: "The path is too long." };
  if (/[\\\u0000-\u001f]/.test(raw)) return { error: "The path has a backslash or a control character: write it with / between its parts." };
  const parts = raw
    .trim()
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return { error: "The path may not go up with \"..\"." };
  const [folder, ...rest] = parts;
  if (!folder || !folders.includes(folder)) {
    return { error: `The path must start with one of the folders: ${folders.map((f) => `"${f}"`).join(", ")}.` };
  }
  return { folder, parts: rest, path: [folder, ...rest].join("/") };
}

/** The bytes of `text` in UTF-8. */
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A message from the app, checked; null for anything else. */
export function readDesktopMessage(raw: string): DesktopMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.type === "pong") return { type: "pong" };
  if (value.type === "hello") {
    const folders = Array.isArray(value.folders) ? value.folders : null;
    if (!folders || folders.length > MAX_LOCAL_FOLDERS || !folders.every(isFolderLabel) || new Set(folders).size !== folders.length) return null;
    const version = typeof value.version === "string" ? value.version.slice(0, 40) : "";
    return { type: "hello", version, folders };
  }
  if (value.type === "result" && typeof value.id === "string" && value.id.length <= 64) {
    if (value.ok === false) {
      const error = DESKTOP_ERRORS.find((e) => e === value.error) ?? "failed";
      return { type: "result", id: value.id, ok: false, error };
    }
    const result = readResult(value.result);
    return result ? { type: "result", id: value.id, ok: true, result } : { type: "result", id: value.id, ok: false, error: "failed" };
  }
  return null;
}

function readResult(value: unknown): DesktopResult | null {
  if (!isObject(value)) return null;
  switch (value.op) {
    case "list": {
      if (!Array.isArray(value.entries)) return null;
      const entries = value.entries.slice(0, MAX_LOCAL_LIST_ENTRIES).flatMap((e): DesktopEntry[] => {
        if (!isObject(e) || typeof e.name !== "string" || !e.name || e.name.length > 1_000) return [];
        const kind = e.kind === "file" || e.kind === "folder" || e.kind === "link" ? e.kind : "other";
        const size = typeof e.size === "number" && Number.isFinite(e.size) && e.size >= 0 ? e.size : 0;
        return [{ name: e.name, kind, size, modified: typeof e.modified === "string" ? e.modified.slice(0, 40) : "" }];
      });
      return { op: "list", entries, truncated: value.truncated === true || value.entries.length > MAX_LOCAL_LIST_ENTRIES };
    }
    case "read":
      if (typeof value.text !== "string" || utf8Bytes(value.text) > MAX_LOCAL_FILE_BYTES) return null;
      return { op: "read", text: value.text, bytes: typeof value.bytes === "number" ? value.bytes : utf8Bytes(value.text) };
    case "write":
      return { op: "write", bytes: typeof value.bytes === "number" ? value.bytes : 0, created: value.created === true };
    case "trash":
      return { op: "trash" };
    default:
      return null;
  }
}

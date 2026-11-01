/**
 * Agents' access to files on this computer: while the person turns it on and picks folders (menu,
 * Agent File Access), the app keeps a websocket open to its server's `/desktop-bridge` with the
 * window's session cookie (server/desktop-bridge/ in the web app) and announces the folders by
 * label only. The server then asks it, for that person's chats with agents, to list a folder, read
 * a text file, write one or move one to the trash. Writes and moves to the trash are asked of the
 * person every time (main.ts shows the question; no answer in two minutes is a no), and nothing is
 * ever deleted for good. Every call, done or refused, is a line in a log on this computer.
 *
 * Everything here is checked again on this side, whatever the server sent: a place is
 * `<folder label>/<path inside it>`; `..`, backslashes, control and invisible characters, `:` and
 * names Windows keeps for devices are refused; a read may follow links that end inside its folder,
 * while a write or a move to the trash follows none, anywhere in the path, and never touches a
 * hidden (`.`) name or a place things start from at sign-in; places that hold keys, passwords or
 * settings (`.ssh`, `.git`, `.env` files, keychains, shell histories …) are never touched; reads
 * and writes stop at 512 KB, and a file that isn't UTF-8 text isn't read. Nothing runs a shell.
 * The rules mirror src/lib/desktop-bridge.ts in the web app.
 *
 * The bridge only connects for the server the windows show, with that server's own settings, and
 * closes and connects again when the server's pings stop.
 *
 * Pure apart from the file system: Electron's parts (dialogs, the trash, cookies) come from main.ts.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const BRIDGE_PATH = "/desktop-bridge";
/** Sent with the upgrade request: no web page can set it on a websocket. */
export const BRIDGE_HEADER = "x-leafdesk-desktop";
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_LIST_ENTRIES = 500;
export const MAX_FOLDERS = 20;
/** How long the person has to answer a write or a trash. */
export const APPROVAL_MS = 2 * 60_000;
/** The log is rotated past this size, keeping one older file. */
export const AUDIT_MAX_BYTES = 1024 * 1024;
/** How often the server pings (DESKTOP_PING_MS in the web app): none for twice this, and the connection is taken as lost. */
export const PING_MS = 30_000;
const MAX_LABEL = 100;
const MAX_PLACE = 1_000;
/** A write's preview shows its first lines and its last ones, with how many are left out between. */
const PREVIEW_HEAD = 8;
const PREVIEW_TAIL = 4;
const PREVIEW_LINE_CHARS = 200;

/** Control characters and ones that change how text around them reads (direction marks, zero-width ones). */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "g");

/** Text with those characters taken out, for names shown in a question. */
export function withoutHidden(text: string): string {
  return text.replace(HIDDEN_ALL, "");
}

export type FileOp = "list" | "read" | "write" | "trash";
export type FileError = "denied" | "unanswered" | "notFound" | "outside" | "protected" | "tooLarge" | "binary" | "notFile" | "notFolder" | "failed";

/** A refusal with its reason, as the server is told it. */
export class FileRefusal extends Error {
  readonly code: FileError;
  constructor(code: FileError) {
    super(code);
    this.code = code;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

/** Kept in the app's settings: off unless the person turns it on, and the folders they picked. */
export type AgentFilesSettings = { enabled: boolean; folders: string[] };

/** The settings as stored, checked: absolute folders, each once, at most MAX_FOLDERS. */
export function readAgentFilesSettings(value: unknown): AgentFilesSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { enabled, folders } = value as Partial<AgentFilesSettings>;
  const kept = Array.isArray(folders) ? [...new Set(folders.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)))].slice(0, MAX_FOLDERS) : [];
  return { enabled: enabled === true, folders: kept };
}

/**
 * The settings of each server the app has connected to, by main.ts's `serverKey()` ("local" or the
 * server's origin): folders picked for one server are never offered to another.
 */
export type AgentFilesByServer = Record<string, AgentFilesSettings>;

export function readAgentFilesByServer(value: unknown): AgentFilesByServer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kept = Object.entries(value).flatMap(([key, settings]) => {
    const read = readAgentFilesSettings(settings);
    return key && read ? [[key, read] as const] : [];
  });
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Settings kept before they were per server go to the server open now (none: they are dropped). */
export function moveToServer(legacy: AgentFilesSettings | undefined, byServer: AgentFilesByServer | undefined, key: string | undefined): AgentFilesByServer | undefined {
  if (!legacy || !key || byServer?.[key]) return byServer;
  return { ...byServer, [key]: legacy };
}

/** A folder agents may use, and the label the server knows it by. */
export type AllowedFolder = { label: string; root: string };

/** The folders agents may use now: none while access is off, whatever was picked. */
export function activeFolders(settings: AgentFilesSettings | undefined): AllowedFolder[] {
  return settings?.enabled ? folderLabels(settings.folders) : [];
}

/** Each folder's label: its name, made a plain name, with " (2)" and so on where two have the same. */
export function folderLabels(folders: readonly string[]): AllowedFolder[] {
  const used = new Set<string>();
  return folders.slice(0, MAX_FOLDERS).map((root) => {
    let base = withoutHidden(path.basename(root).replace(/[/\\]/g, "-")).trim().slice(0, MAX_LABEL - 5);
    if (!base || base === "." || base === "..") base = "Folder";
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base} (${n})`;
    used.add(label);
    return { label, root };
  });
}

// ── Places that are never touched ───────────────────────────────────────────────────────────

const PROTECTED_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".git", ".password-store", ".terraform.d", "keychains", "keyrings", "kwalletd"]);
const PROTECTED_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".gitconfig",
  ".pgpass",
  ".htpasswd",
  ".vault-token",
  ".zsh_history",
  ".bash_history",
  ".sh_history",
  ".histfile",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
]);
const PROTECTED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keychain", ".keychain-db", ".gpg", ".asc", ".ppk"];
/** Names protected only inside a certain folder: `.config/gh`, `.cargo/credentials.toml` … */
const PROTECTED_INSIDE: readonly [string, (name: string) => boolean][] = [
  [".config", (name) => name === "gh" || name === "gcloud"],
  [".cargo", (name) => name.startsWith("credentials")],
];
/** Where things start from at sign-in: nothing is written there, whatever folder it is in. */
const STARTS_AT_SIGN_IN = [
  ["library", "launchagents"],
  ["library", "launchdaemons"],
  ["start menu", "programs", "startup"],
  [".config", "autostart"],
];

/** Whether a file or folder's name marks keys, passwords or settings, which agents never use. */
export function isProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return PROTECTED_FOLDERS.has(lower) || PROTECTED_FILES.has(lower) || lower.startsWith(".env") || lower.includes(".tfstate") || PROTECTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const partsOf = (fullPath: string) => fullPath.split(/[/\\]/).filter(Boolean);

/** Whether a path's parts pass through such a place (letter case aside). */
export function hasProtectedParts(parts: readonly string[]): boolean {
  const lower = parts.map((part) => part.toLowerCase());
  return lower.some((part, i) => isProtectedName(part) || (i > 0 && PROTECTED_INSIDE.some(([parent, inside]) => lower[i - 1] === parent && inside(part))));
}

/** Whether a path, from the top of the file system, passes through such a place. */
export function hasProtectedPart(fullPath: string): boolean {
  return hasProtectedParts(partsOf(fullPath));
}

/** Whether a path passes through a place things start from at sign-in. */
export function startsAtSignIn(fullPath: string): boolean {
  const lower = partsOf(fullPath).map((part) => part.toLowerCase());
  return STARTS_AT_SIGN_IN.some((run) => lower.some((_, i) => run.every((part, j) => lower[i + j] === part)));
}

/**
 * Whether a folder the person picked can't be offered to agents: the whole disk, the home
 * folder or one holding it, the system's settings for apps (`~/Library`, `AppData`) or inside
 * them, or a place of keys and passwords. `real` is the folder through its links.
 */
export function refusedRoot(real: string, home: string, platform: NodeJS.Platform): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
  const folder = fold(p.resolve(real));
  const homeFolder = fold(p.resolve(home));
  const within = (parent: string, child: string) => {
    const relative = p.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
  };
  if (p.parse(folder).root === folder || hasProtectedPart(real)) return true;
  // The home folder, or a folder holding it.
  if (within(folder, homeFolder)) return true;
  const settings = platform === "win32" ? ["AppData"] : platform === "darwin" ? ["Library"] : [".config", ".local"];
  return settings.some((name) => within(fold(p.join(homeFolder, name)), folder));
}

// ── Places ──────────────────────────────────────────────────────────────────────────────────

/** A place resolved on this computer: `real` is inside `root` (both through links), `exists` whether it is there. */
export type Resolved = { label: string; root: string; parts: string[]; real: string; exists: boolean };

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** Names Windows keeps for devices, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/**
 * Whether a part of a path can't be used on every system alike: a `:` (another stream of a file on
 * Windows), a device name, or a trailing dot or space (which Windows drops, so `id_rsa.` would be
 * `id_rsa`). Checked everywhere, so the rules are the same on every computer.
 */
export function isUnsafePart(part: string): boolean {
  return part.includes(":") || DEVICE_NAME.test(part) || part.endsWith(".") || part.endsWith(" ");
}

/**
 * Where a place the server sent is on this computer, or why it can't be used: the folder by its
 * label, the path inside it resolved through links as far as it exists, and refused when it
 * leaves the folder or a link leads back to the folder itself (`outside`) or passes a protected
 * place (`protected`). A change checks more with `checkChangePlace`.
 */
export async function resolvePlace(folders: readonly AllowedFolder[], raw: unknown): Promise<Resolved> {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_PLACE) throw new FileRefusal("outside");
  if (raw.includes("\\") || HIDDEN.test(raw)) throw new FileRefusal("outside");
  const all = raw
    .trim()
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (all.some((part) => part === "..")) throw new FileRefusal("outside");
  const [label, ...parts] = all;
  const folder = folders.find((f) => f.label === label);
  if (!folder) throw new FileRefusal("outside");
  if (hasProtectedParts(parts)) throw new FileRefusal("protected");
  if (parts.some(isUnsafePart)) throw new FileRefusal("outside");

  let root: string;
  try {
    root = await fs.realpath(folder.root);
  } catch {
    throw new FileRefusal("notFound");
  }
  if (hasProtectedPart(root)) throw new FileRefusal("protected");
  // The longest part of the path that exists, through its links; the rest is appended as written.
  for (let i = parts.length; i >= 0; i--) {
    let real: string;
    try {
      real = await fs.realpath(path.join(root, ...parts.slice(0, i)));
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") continue;
      throw new FileRefusal("failed");
    }
    const full = path.join(real, ...parts.slice(i));
    if (!isInside(root, full) || (parts.length && full === root)) throw new FileRefusal("outside");
    if (hasProtectedPart(full)) throw new FileRefusal("protected");
    return { label: folder.label, root, parts, real: full, exists: i === parts.length };
  }
  throw new FileRefusal("notFound");
}

/**
 * What a write or a move to the trash must also hold: a place strictly inside its folder, no
 * hidden (`.`) name in it, not where things start from at sign-in, and no link anywhere along it,
 * the last part included (each part that exists is looked at itself, from the folder down, rather
 * than through links: on Windows a file can't be opened refusing links).
 */
export async function checkChangePlace(place: Resolved): Promise<void> {
  if (!place.parts.length || place.real === place.root) throw new FileRefusal("protected");
  if (place.parts.some((part) => part.startsWith(".")) || startsAtSignIn(place.real)) throw new FileRefusal("protected");
  let at = place.root;
  for (const part of place.parts) {
    at = path.join(at, part);
    let stat;
    try {
      stat = await fs.lstat(at);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw new FileRefusal(errorCode(error) === "ENOTDIR" ? "notFound" : "failed");
    }
    if (stat.isSymbolicLink()) throw new FileRefusal("outside");
  }
}

// ── What a call does ────────────────────────────────────────────────────────────────────────

export type Entry = { name: string; kind: "file" | "folder" | "link" | "other"; size: number; modified: string };

/** A folder's entries by name (protected ones left out), at most MAX_LIST_ENTRIES. */
export async function listFolder(place: Resolved): Promise<{ entries: Entry[]; truncated: boolean }> {
  if (!place.exists) throw new FileRefusal("notFound");
  const stat = await fs.stat(place.real);
  if (!stat.isDirectory()) throw new FileRefusal("notFolder");
  const names = (await fs.readdir(place.real)).filter((name) => !isProtectedName(name)).sort((a, b) => a.localeCompare(b));
  const entries: Entry[] = [];
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    const entry = await fs.lstat(path.join(place.real, name)).catch(() => null);
    if (!entry) continue;
    const kind = entry.isDirectory() ? "folder" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
    entries.push({ name, kind, size: kind === "file" ? entry.size : 0, modified: entry.mtime.toISOString() });
  }
  return { entries, truncated: names.length > MAX_LIST_ENTRIES };
}

/** Text that is UTF-8 with no NUL bytes; null for anything else. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// On macOS and Linux a link swapped in for the file's last part after the checks isn't followed
// when opening. Windows has no such flag (0): there the checks just before opening are all there is,
// and a link swapped in between them and the open, or in a folder above, isn't caught.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** A text file's contents, at most MAX_FILE_BYTES. */
export async function readText(place: Resolved): Promise<{ text: string; bytes: number }> {
  if (!place.exists) throw new FileRefusal("notFound");
  const stat = await fs.stat(place.real);
  if (stat.isDirectory()) throw new FileRefusal("notFile");
  if (!stat.isFile()) throw new FileRefusal("failed");
  if (stat.size > MAX_FILE_BYTES) throw new FileRefusal("tooLarge");
  const handle = await fs.open(place.real, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new FileRefusal("tooLarge");
    const text = textOf(buffer.subarray(0, length));
    if (text === null) throw new FileRefusal("binary");
    return { text, bytes: length };
  } finally {
    await handle.close();
  }
}

/** Writes a text file, making missing folders inside its folder; `created` when it wasn't there. */
export async function writeText(folders: readonly AllowedFolder[], placeText: string, content: string): Promise<{ bytes: number; created: boolean }> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new FileRefusal("tooLarge");
  const place = await resolvePlace(folders, placeText);
  if (!place.parts.length) throw new FileRefusal("notFile");
  await checkChangePlace(place);
  if (place.exists && (await fs.lstat(place.real)).isDirectory()) throw new FileRefusal("notFile");
  if (!place.exists) await fs.mkdir(path.dirname(place.real), { recursive: true });
  // Checked again just before opening: a part may have been swapped for a link meanwhile.
  const again = await resolvePlace(folders, placeText);
  if (again.real !== place.real) throw new FileRefusal("outside");
  await checkChangePlace(again);
  const handle = await fs.open(place.real, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NO_FOLLOW, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return { bytes, created: !place.exists };
}

// ── Asking the person ───────────────────────────────────────────────────────────────────────

/** What the person is asked about. */
export type Approval = { op: "write" | "trash"; agent: string; workspace: string; place: string; server: string; bytes?: number; preview?: string };

/**
 * What a write puts in the file, for the question: its first lines and, when longer, its last ones
 * with `more(count)` between, so nothing hides at the end; characters that change how text reads
 * are taken out, and tabs shown as spaces.
 */
export function previewOf(content: string, more: (count: number) => string = (count) => `… ${count} …`): string {
  const lines = content.trimEnd().split(/\r?\n/);
  const clean = (line: string) => {
    const plain = withoutHidden(line.replaceAll("\t", "  "));
    return plain.length > PREVIEW_LINE_CHARS ? `${plain.slice(0, PREVIEW_LINE_CHARS)}…` : plain;
  };
  if (lines.length <= PREVIEW_HEAD + PREVIEW_TAIL + 1) return lines.map(clean).join("\n");
  return [...lines.slice(0, PREVIEW_HEAD).map(clean), more(lines.length - PREVIEW_HEAD - PREVIEW_TAIL), ...lines.slice(-PREVIEW_TAIL).map(clean)].join("\n");
}

/** Bytes as the question shows them. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * Asks and waits at most `ms`: `ask` gets a signal that aborts at the deadline (main.ts closes the
 * question with it). An error asking is a no.
 */
export async function askWithTimeout(ask: (signal: AbortSignal) => Promise<boolean>, ms: number): Promise<"allowed" | "denied" | "unanswered"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"unanswered">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unanswered");
    }, ms);
  });
  try {
    return await Promise.race([ask(controller.signal).then((yes) => (yes ? "allowed" : "denied"), () => "denied" as const), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the questions one after another, so the person sees one at a time; one whose time ran out while waiting is skipped as a no. */
export function oneAtATime() {
  let chain: Promise<unknown> = Promise.resolve();
  return (ask: (signal: AbortSignal) => Promise<boolean>) =>
    (signal: AbortSignal): Promise<boolean> => {
      const turn = chain.then(() => (signal.aborted ? false : ask(signal)));
      chain = turn.catch(() => undefined);
      return turn;
    };
}

// ── The log ─────────────────────────────────────────────────────────────────────────────────

/** One call as the log keeps it: the place and size, never what a file holds. */
export type AuditEntry = { at: string; server: string; agent: string; workspace: string; op: FileOp; place: string; outcome: "done" | FileError; bytes?: number };

export function auditLine(entry: AuditEntry): string {
  const { at, server, agent, workspace, op, place, outcome, bytes } = entry;
  return `${JSON.stringify({ at, server, agent, workspace, op, place, outcome, ...(bytes !== undefined ? { bytes } : {}) })}\n`;
}

/** Appends a line to the log, moving it to `<file>.1` first once it would pass `maxBytes`. */
export async function appendAudit(file: string, line: string, maxBytes = AUDIT_MAX_BYTES) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const size = await fs.stat(file).then(
    (s) => s.size,
    () => 0,
  );
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await fs.rename(file, `${file}.1`);
  await fs.appendFile(file, line, { mode: 0o600 });
}

// ── A call from the server ──────────────────────────────────────────────────────────────────

export type Call = { type: "call"; id: string; op: FileOp; path: string; content?: string; agent: string; workspace: string };
export type Result =
  | { type: "result"; id: string; ok: true; result: Record<string, unknown> & { op: FileOp } }
  | { type: "result"; id: string; ok: false; error: FileError };

/** What answering a call needs from the app. */
export type FileHost = {
  /** The server the bridge is connected to, for the question and the log. */
  server: string;
  folders: () => readonly AllowedFolder[];
  /** Asks the person; aborted at the deadline. */
  ask: (approval: Approval, signal: AbortSignal) => Promise<boolean>;
  /** Moves a file or folder to the system's trash. */
  trash: (fullPath: string) => Promise<void>;
  audit: (entry: AuditEntry) => Promise<void>;
  /** The line a long preview shows between its first and last lines, in the person's language. */
  moreLines?: (count: number) => string;
  now?: () => Date;
  approvalMs?: number;
};

const OPS: readonly FileOp[] = ["list", "read", "write", "trash"];

/** A server message, if it is a call this side can take. */
export function readCall(value: unknown): Call | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "call" || typeof v.id !== "string" || v.id.length > 64 || !OPS.includes(v.op as FileOp) || typeof v.path !== "string") return null;
  if (v.op === "write" && typeof v.content !== "string") return null;
  // Shown in the question: nothing in them may turn the text around or hide part of it.
  const name = (x: unknown) => (typeof x === "string" ? withoutHidden(x).trim().slice(0, 200) : "");
  return { type: "call", id: v.id, op: v.op as FileOp, path: v.path, ...(v.op === "write" ? { content: v.content as string } : {}), agent: name(v.agent), workspace: name(v.workspace) };
}

/** Answers one call: checks the place, asks the person before a change, does it, and logs it. */
export async function answerCall(call: Call, host: FileHost): Promise<Result> {
  const bytes = call.op === "write" ? Buffer.byteLength(call.content ?? "", "utf8") : undefined;
  const log = (outcome: AuditEntry["outcome"]) =>
    host
      .audit({ at: (host.now?.() ?? new Date()).toISOString(), server: host.server, agent: call.agent, workspace: call.workspace, op: call.op, place: call.path.slice(0, MAX_PLACE), outcome, bytes })
      .catch(() => undefined);
  try {
    const result = await perform(call, host, bytes);
    await log("done");
    return { type: "result", id: call.id, ok: true, result };
  } catch (error) {
    const code = error instanceof FileRefusal ? error.code : errorCode(error) === "ENOENT" ? "notFound" : "failed";
    await log(code);
    return { type: "result", id: call.id, ok: false, error: code };
  }
}

async function perform(call: Call, host: FileHost, bytes: number | undefined): Promise<Record<string, unknown> & { op: FileOp }> {
  const place = await resolvePlace(host.folders(), call.path);
  if (call.op === "list") return { op: "list", ...(await listFolder(place)) };
  if (call.op === "read") return { op: "read", ...(await readText(place)) };

  // Checked before asking, so the person isn't asked about something that can't be done.
  let trashBytes: number | undefined;
  if (call.op === "write") {
    if ((bytes ?? 0) > MAX_FILE_BYTES) throw new FileRefusal("tooLarge");
    if (!place.parts.length) throw new FileRefusal("notFile");
    await checkChangePlace(place);
    if (place.exists && (await fs.lstat(place.real)).isDirectory()) throw new FileRefusal("notFile");
  } else {
    if (!place.parts.length) throw new FileRefusal("protected");
    if (!place.exists) throw new FileRefusal("notFound");
    await checkChangePlace(place);
    const stat = await fs.lstat(place.real);
    if (stat.isFile()) trashBytes = stat.size;
  }
  const approval: Approval = {
    op: call.op,
    agent: call.agent,
    workspace: call.workspace,
    place: [place.label, ...place.parts].join("/"),
    server: host.server,
    ...(call.op === "write" ? { bytes, preview: previewOf(call.content ?? "", host.moreLines) } : trashBytes !== undefined ? { bytes: trashBytes } : {}),
  };
  const answer = await askWithTimeout((signal) => host.ask(approval, signal), host.approvalMs ?? APPROVAL_MS);
  if (answer !== "allowed") throw new FileRefusal(answer === "denied" ? "denied" : "unanswered");

  // Access may have been turned off or the folders changed while the person thought about it:
  // everything is checked again (no folders while it is off).
  if (call.op === "write") return { op: "write", ...(await writeText(host.folders(), call.path, call.content ?? "")) };
  const again = await resolvePlace(host.folders(), call.path);
  if (!again.exists || !again.parts.length) throw new FileRefusal("notFound");
  await checkChangePlace(again);
  await host.trash(again.real);
  return { op: "trash" };
}

// ── The connection ──────────────────────────────────────────────────────────────────────────

/** The websocket's address on a server. */
export function bridgeUrl(origin: string): string {
  const url = new URL(BRIDGE_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** How long to wait before connecting again after `failures` failed tries in a row: 1 s doubling to a minute. */
export function reconnectDelay(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6));
}

/** The part of a websocket the bridge uses (the WebSocket of Node and browsers). */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

/** Where the bridge connects and what it announces; null while file access is off or no server is open. */
export type BridgeTarget = { origin: string; folders: readonly AllowedFolder[] } | null;

/** Why the bridge isn't connected, when that is known: the menu says so. */
export type BridgeProblem = "signedOut" | "certificate" | "unreachable";

export type BridgeDeps = {
  open: (url: string, headers: Record<string, string>) => SocketLike;
  /** The Cookie header the window's session holds for the server. */
  cookie: (origin: string) => Promise<string>;
  version: string;
  answer: (call: Call, origin: string) => Promise<Result>;
  onStatus?: (connected: boolean, problem?: BridgeProblem) => void;
};

const OPEN = 1;
/** What the server closes the socket with when no session or an ended one came with it (server/desktop-bridge/). */
const SIGNED_OUT_CODES = new Set([4401, 4403]);
const CERTIFICATE_CODE = /CERT|SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS/i;

/**
 * Why a connection failed, from the error it failed with (and the errors that caused it): the
 * system not trusting the server's certificate, or the server not answering. The app's own trust
 * in a certificate (certificates.ts) covers its windows only, not this connection.
 */
export function problemOf(error: unknown): "certificate" | "unreachable" {
  let at: unknown = error;
  for (let depth = 0; depth < 6 && at && typeof at === "object"; depth++) {
    const { code, message } = at as { code?: unknown; message?: unknown };
    if ((typeof code === "string" && CERTIFICATE_CODE.test(code)) || (typeof message === "string" && /certificate/i.test(message))) return "certificate";
    const next = at as { error?: unknown; cause?: unknown };
    at = next.error ?? next.cause;
  }
  return "unreachable";
}

/**
 * Keeps the websocket to the server open while there is a target, reconnecting with backoff, and
 * taking the connection as lost when the server's pings stop for twice their interval (a socket
 * whose network went away can stay "open" for a long time).
 */
export class AgentFilesBridge {
  private readonly deps: BridgeDeps;
  private target: BridgeTarget = null;
  /** Counts the servers followed: a connection or retry started for an earlier one gives up. */
  private generation = 0;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastHeard = 0;
  private failures = 0;
  private connected = false;
  private problem: BridgeProblem | undefined;
  private reported: string | undefined;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  get isConnected() {
    return this.connected;
  }

  /**
   * Follows a new target: reconnects for another server, says hello again for other folders,
   * closes for none. The same server with the same folders (main.ts makes a new target each time
   * its menu is drawn) changes nothing.
   */
  update(target: BridgeTarget) {
    const before = this.target;
    const next = target && target.folders.length ? target : null;
    if (next && before && next.origin === before.origin) {
      this.target = next;
      if (labels(next) !== labels(before) && this.socket?.readyState === OPEN && this.connected) this.hello(this.socket);
      return;
    }
    this.target = next;
    this.generation++;
    this.drop();
    this.failures = 0;
    this.problem = undefined;
    this.report();
    if (next) void this.connect();
  }

  stop() {
    this.update(null);
  }

  private hello(socket: SocketLike) {
    if (!this.target) return;
    socket.send(JSON.stringify({ type: "hello", version: this.deps.version, folders: this.target.folders.map((f) => f.label) }));
  }

  /** Tells the app when being connected, or why not, changed. */
  private report() {
    const now = `${this.connected}:${this.connected ? "" : (this.problem ?? "")}`;
    if (now === this.reported) return;
    this.reported = now;
    this.deps.onStatus?.(this.connected, this.connected ? undefined : this.problem);
  }

  private setConnected(value: boolean) {
    this.connected = value;
    this.report();
  }

  private close(socket: SocketLike) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000);
    } catch {}
  }

  private drop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) this.close(socket);
    this.setConnected(false);
  }

  private async connect() {
    const generation = this.generation;
    const origin = this.target?.origin;
    if (!origin) return;
    let socket: SocketLike;
    try {
      const cookie = await this.deps.cookie(origin);
      if (this.generation !== generation) return;
      socket = this.deps.open(bridgeUrl(origin), { [BRIDGE_HEADER]: "1", ...(cookie ? { cookie } : {}) });
    } catch (error) {
      this.problem = problemOf(error);
      this.report();
      this.retry(generation);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.problem = undefined;
      this.lastHeard = Date.now();
      this.watch(socket, generation);
      this.setConnected(true);
      this.hello(socket);
    };
    socket.onmessage = (event) => this.receive(socket, origin, event.data);
    socket.onerror = (event) => {
      if (this.socket === socket) this.problem = problemOf(event);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      if (event?.code !== undefined && SIGNED_OUT_CODES.has(event.code)) this.problem = "signedOut";
      this.lost(socket, generation);
    };
  }

  /** The socket is gone, or taken as gone: forgets it and tries again. */
  private lost(socket: SocketLike, generation: number) {
    if (this.socket !== socket) return;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.socket = null;
    this.close(socket);
    this.problem ??= "unreachable";
    this.setConnected(false);
    this.retry(generation);
  }

  /** Takes the connection as lost once nothing came from the server for twice the ping interval. */
  private watch(socket: SocketLike, generation: number) {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > 2 * PING_MS) this.lost(socket, generation);
    }, PING_MS);
    this.watchdog.unref?.();
  }

  private retry(generation: number) {
    if (this.generation !== generation || !this.target) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.generation === generation && this.target && !this.socket) void this.connect();
    }, reconnectDelay(this.failures++));
    this.timer.unref?.();
  }

  private receive(socket: SocketLike, origin: string, data: unknown) {
    if (this.socket === socket) this.lastHeard = Date.now();
    let message: unknown;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if ((message as { type?: unknown } | null)?.type === "ping") {
      socket.send('{"type":"pong"}');
      return;
    }
    const call = readCall(message);
    if (!call) return;
    void this.deps.answer(call, origin).then((result) => {
      if (this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify(result));
    });
  }
}

const labels = (target: NonNullable<BridgeTarget>) => target.folders.map((f) => f.label).join("\n");

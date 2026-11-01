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
 * `<folder label>/<path inside it>`; `..`, backslashes and control characters are refused; the
 * existing part of a path is resolved through links and must stay inside its folder; places that
 * hold keys, passwords or settings (`.ssh`, `.git`, `.env` files, keychains …) are never touched;
 * reads and writes stop at 512 KB, and a file that isn't UTF-8 text isn't read. Nothing runs a
 * shell. The rules mirror src/lib/desktop-bridge.ts in the web app.
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
const MAX_LABEL = 100;
const MAX_PLACE = 1_000;
const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 200;

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

/** A folder agents may use, and the label the server knows it by. */
export type AllowedFolder = { label: string; root: string };

/** Each folder's label: its name, made a plain name, with " (2)" and so on where two have the same. */
export function folderLabels(folders: readonly string[]): AllowedFolder[] {
  const used = new Set<string>();
  return folders.slice(0, MAX_FOLDERS).map((root) => {
    let base = path.basename(root).replace(/[/\\\u0000-\u001f]/g, "-").trim().slice(0, MAX_LABEL - 5);
    if (!base || base === "." || base === "..") base = "Folder";
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base} (${n})`;
    used.add(label);
    return { label, root };
  });
}

// ── Places that are never touched ───────────────────────────────────────────────────────────

const PROTECTED_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".git", ".password-store", "keychains"]);
const PROTECTED_FILES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", ".gitconfig", ".pgpass", ".htpasswd", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts", "authorized_keys"]);
const PROTECTED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keychain", ".keychain-db", ".gpg", ".asc", ".ppk"];

/** Whether a file or folder's name marks keys, passwords or settings, which agents never use. */
export function isProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return PROTECTED_FOLDERS.has(lower) || PROTECTED_FILES.has(lower) || lower.startsWith(".env") || PROTECTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Whether a path, from the top of the file system, passes through such a place. */
export function hasProtectedPart(fullPath: string): boolean {
  return fullPath.split(/[/\\]/).some((part) => part && isProtectedName(part));
}

// ── Places ──────────────────────────────────────────────────────────────────────────────────

/** A place resolved on this computer: `real` is inside `root` (both through links), `exists` whether it is there. */
export type Resolved = { label: string; root: string; parts: string[]; real: string; exists: boolean };

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Where a place the server sent is on this computer, or why it can't be used: the folder by its
 * label, the path inside it resolved through links as far as it exists, and refused when it
 * leaves the folder (`outside`) or passes a protected place (`protected`).
 */
export async function resolvePlace(folders: readonly AllowedFolder[], raw: unknown): Promise<Resolved> {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_PLACE) throw new FileRefusal("outside");
  if (/[\\\u0000-\u001f]/.test(raw)) throw new FileRefusal("outside");
  const all = raw
    .trim()
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (all.some((part) => part === "..")) throw new FileRefusal("outside");
  const [label, ...parts] = all;
  const folder = folders.find((f) => f.label === label);
  if (!folder) throw new FileRefusal("outside");
  if (parts.some(isProtectedName)) throw new FileRefusal("protected");

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
    if (!isInside(root, full)) throw new FileRefusal("outside");
    if (hasProtectedPart(path.relative(root, full))) throw new FileRefusal("protected");
    return { label: folder.label, root, parts, real: full, exists: i === parts.length };
  }
  throw new FileRefusal("notFound");
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

// A link swapped in after the check isn't followed when opening (where the system has the flag).
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
  if (place.exists && (await fs.stat(place.real)).isDirectory()) throw new FileRefusal("notFile");
  if (!place.exists) {
    await fs.mkdir(path.dirname(place.real), { recursive: true });
    // Checked again once the folders are there: one may have been swapped for a link meanwhile.
    const again = await resolvePlace(folders, placeText);
    if (again.real !== place.real) throw new FileRefusal("outside");
  }
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

/** The first lines of what a write puts in the file, for the question. */
export function previewOf(content: string): string {
  return content
    .split(/\r?\n/)
    .slice(0, PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line))
    .join("\n")
    .trimEnd();
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
  const name = (x: unknown) => (typeof x === "string" ? x.slice(0, 200) : "");
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
  if (call.op === "write") {
    if ((bytes ?? 0) > MAX_FILE_BYTES) throw new FileRefusal("tooLarge");
    if (!place.parts.length || (place.exists && (await fs.stat(place.real)).isDirectory())) throw new FileRefusal("notFile");
  } else {
    if (!place.parts.length) throw new FileRefusal("protected");
    if (!place.exists) throw new FileRefusal("notFound");
  }
  const approval: Approval = {
    op: call.op,
    agent: call.agent,
    workspace: call.workspace,
    place: [place.label, ...place.parts].join("/"),
    server: host.server,
    ...(call.op === "write" ? { bytes, preview: previewOf(call.content ?? "") } : {}),
  };
  const answer = await askWithTimeout((signal) => host.ask(approval, signal), host.approvalMs ?? APPROVAL_MS);
  if (answer !== "allowed") throw new FileRefusal(answer === "denied" ? "denied" : "unanswered");

  // The folders may have changed while the person thought about it: everything is checked again.
  if (call.op === "write") return { op: "write", ...(await writeText(host.folders(), call.path, call.content ?? "")) };
  const again = await resolvePlace(host.folders(), call.path);
  if (!again.exists || !again.parts.length) throw new FileRefusal("notFound");
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
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

/** Where the bridge connects and what it announces; null while file access is off or no server is open. */
export type BridgeTarget = { origin: string; folders: readonly AllowedFolder[] } | null;

export type BridgeDeps = {
  open: (url: string, headers: Record<string, string>) => SocketLike;
  /** The Cookie header the window's session holds for the server. */
  cookie: (origin: string) => Promise<string>;
  version: string;
  answer: (call: Call, origin: string) => Promise<Result>;
  onStatus?: (connected: boolean) => void;
};

const OPEN = 1;

/** Keeps the websocket to the server open while there is a target, reconnecting with backoff. */
export class AgentFilesBridge {
  private readonly deps: BridgeDeps;
  private target: BridgeTarget = null;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private connected = false;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  get isConnected() {
    return this.connected;
  }

  /** Follows a new target: reconnects for another server, says hello again for other folders, closes for none. */
  update(target: BridgeTarget) {
    const before = this.target;
    this.target = target && target.folders.length ? target : null;
    if (this.target && before && this.target.origin === before.origin) {
      if (labels(this.target) !== labels(before) && this.socket?.readyState === OPEN && this.connected) this.hello(this.socket);
      return;
    }
    this.drop();
    this.failures = 0;
    if (this.target) void this.connect();
  }

  stop() {
    this.update(null);
  }

  private hello(socket: SocketLike) {
    if (!this.target) return;
    socket.send(JSON.stringify({ type: "hello", version: this.deps.version, folders: this.target.folders.map((f) => f.label) }));
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.deps.onStatus?.(value);
  }

  private drop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000);
      } catch {}
    }
    this.setConnected(false);
  }

  private async connect() {
    const target = this.target;
    if (!target) return;
    let socket: SocketLike;
    try {
      const cookie = await this.deps.cookie(target.origin);
      if (this.target !== target) return;
      socket = this.deps.open(bridgeUrl(target.origin), { [BRIDGE_HEADER]: "1", ...(cookie ? { cookie } : {}) });
    } catch {
      this.retry(target);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.setConnected(true);
      this.hello(socket);
    };
    socket.onmessage = (event) => this.receive(socket, target.origin, event.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      this.retry(target);
    };
  }

  private retry(target: NonNullable<BridgeTarget>) {
    if (this.target !== target) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.target === target && !this.socket) void this.connect();
    }, reconnectDelay(this.failures++));
    this.timer.unref?.();
  }

  private receive(socket: SocketLike, origin: string, data: unknown) {
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

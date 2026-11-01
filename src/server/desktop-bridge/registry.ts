/**
 * The desktop apps connected to this server (lib/desktop-bridge.ts), by person: what each announced
 * (the labels of the folders its person allowed, its version) and the session it came with, and
 * the calls waiting for its answer. Kept on globalThis: server.ts takes the connections, while the
 * agents' worker and Next's pages (the chat's note) ask about them, from separate module graphs.
 *
 * A connection counts once it said hello with at least one folder. A chat's run uses only the app
 * that connected with the session its message was sent from (`sessionId`; agents/computer.ts), the
 * latest of those. A connection silent for two pings, closed, or whose session ended
 * (closeEndedDesktopSessions, from account-security.ts, and closeDesktopSession when
 * agents/computer.ts finds its session gone or expired) is dropped, and the calls waiting on it end
 * as `offline`. Nothing here checks workspace policies: callers ask `policyHoldFor` with `facts`
 * each time (agents/computer.ts).
 */
import { randomUUID } from "node:crypto";
import {
  DESKTOP_CHANGE_TIMEOUT_MS,
  DESKTOP_PING_MS,
  DESKTOP_READ_TIMEOUT_MS,
  readDesktopMessage,
  type DesktopCall,
  type DesktopError,
  type DesktopResult,
  type ServerMessage,
} from "@/lib/desktop-bridge";

/** How a connection reaches its app: the websocket in server.ts, or a stand-in in scripts. */
export type DesktopTransport = { send: (message: ServerMessage) => void; close: (code?: number, reason?: string) => void };

/** What the workspaces' sign-in policies look at in the session the app connected with (access.ts SessionFacts). */
export type DesktopFacts = { strong: boolean; ssoProviderId: string | null; ip: string | null };

export type DesktopAnswer = { ok: true; result: DesktopResult } | { ok: false; error: DesktopError };

type Waiting = { resolve: (answer: DesktopAnswer) => void; timer: ReturnType<typeof setTimeout> };

type Connection = {
  id: string;
  userId: string;
  sessionId: string | null;
  facts: DesktopFacts;
  transport: DesktopTransport;
  connectedAt: number;
  lastSeen: number;
  /** Null until it says hello. */
  folders: string[] | null;
  version: string;
  waiting: Map<string, Waiting>;
};

type Registry = { byUser: Map<string, Connection[]>; pinger: ReturnType<typeof setInterval> | null };
const g = globalThis as typeof globalThis & { __leafdeskDesktops?: Registry };
const registry: Registry = (g.__leafdeskDesktops ??= { byUser: new Map(), pinger: null });

/** A connected app as callers see it. */
export type ConnectedDesktop = { folders: string[]; version: string; facts: DesktopFacts; sessionId: string | null };

/** The handle server.ts keeps for a socket: what came in, and that it closed. */
export type DesktopLink = { receive: (raw: string) => void; closed: () => void };

/** Takes a newly opened connection of `userId`'s app. */
export function connectDesktop(input: { userId: string; sessionId: string | null; facts: DesktopFacts; transport: DesktopTransport }): DesktopLink {
  const now = Date.now();
  const connection: Connection = { ...input, id: randomUUID(), connectedAt: now, lastSeen: now, folders: null, version: "", waiting: new Map() };
  const list = registry.byUser.get(input.userId) ?? [];
  registry.byUser.set(input.userId, [...list, connection]);
  startPinging();
  return {
    receive: (raw) => receive(connection, raw),
    closed: () => drop(connection),
  };
}

function receive(connection: Connection, raw: string) {
  connection.lastSeen = Date.now();
  const message = readDesktopMessage(raw);
  if (!message) return;
  if (message.type === "hello") {
    connection.folders = message.folders;
    connection.version = message.version;
    return;
  }
  if (message.type === "result") {
    const waiting = connection.waiting.get(message.id);
    if (!waiting) return;
    connection.waiting.delete(message.id);
    clearTimeout(waiting.timer);
    waiting.resolve(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error });
  }
}

/** Forgets a connection, ending the calls that wait on it. */
function drop(connection: Connection) {
  const list = registry.byUser.get(connection.userId)?.filter((c) => c !== connection) ?? [];
  if (list.length) registry.byUser.set(connection.userId, list);
  else registry.byUser.delete(connection.userId);
  for (const waiting of connection.waiting.values()) {
    clearTimeout(waiting.timer);
    waiting.resolve({ ok: false, error: "offline" });
  }
  connection.waiting.clear();
  if (!registry.byUser.size && registry.pinger) {
    clearInterval(registry.pinger);
    registry.pinger = null;
  }
}

/** The app of `userId` that answers: the latest that announced at least one folder (of those connected with `sessionId`, when given). */
function current(userId: string, sessionId?: string): Connection | null {
  const ready = (registry.byUser.get(userId) ?? []).filter((c) => c.folders && c.folders.length > 0 && (sessionId === undefined || c.sessionId === sessionId));
  return ready.reduce<Connection | null>((latest, c) => (!latest || c.connectedAt > latest.connectedAt ? c : latest), null);
}

/** The person's connected app with folders to use (the one connected with `sessionId`, when given), or null. */
export function desktopOf(userId: string, sessionId?: string): ConnectedDesktop | null {
  const found = current(userId, sessionId);
  return found?.folders ? { folders: [...found.folders], version: found.version, facts: found.facts, sessionId: found.sessionId } : null;
}

/**
 * Asks the person's app (the one connected with `sessionId`, when given) for one thing and waits
 * for its answer: `offline` when there is none (or it goes meanwhile), `timeout` when it doesn't
 * answer in time (a read's 30 seconds, a change's time for the person to answer and a little more).
 */
export function callDesktop(
  userId: string,
  call: Omit<DesktopCall, "type" | "id">,
  { timeoutMs, sessionId }: { timeoutMs?: number; sessionId?: string } = {},
): Promise<DesktopAnswer> {
  const connection = current(userId, sessionId);
  if (!connection) return Promise.resolve({ ok: false, error: "offline" });
  const id = randomUUID();
  const wait = timeoutMs ?? (call.op === "write" || call.op === "trash" ? DESKTOP_CHANGE_TIMEOUT_MS : DESKTOP_READ_TIMEOUT_MS);
  return new Promise<DesktopAnswer>((resolve) => {
    const timer = setTimeout(() => {
      connection.waiting.delete(id);
      resolve({ ok: false, error: "timeout" });
    }, wait);
    timer.unref?.();
    connection.waiting.set(id, { resolve, timer });
    try {
      connection.transport.send({ type: "call", id, ...call });
    } catch {
      connection.waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: "offline" });
    }
  });
}

/** Closes the person's apps whose session ended: all of them when `live` is empty. */
export function closeEndedDesktopSessions(userId: string, live: readonly string[]) {
  const kept = new Set(live);
  for (const connection of registry.byUser.get(userId) ?? []) {
    if (live.length && connection.sessionId && kept.has(connection.sessionId)) continue;
    connection.transport.close(4403, "Forbidden");
    drop(connection);
  }
}

/** Closes the person's apps connected with this session: it was signed out, or ran out. */
export function closeDesktopSession(userId: string, sessionId: string) {
  for (const connection of registry.byUser.get(userId) ?? []) {
    if (connection.sessionId !== sessionId) continue;
    connection.transport.close(4403, "Forbidden");
    drop(connection);
  }
}

/** Pings every app; one that said nothing for two pings is closed. */
export function pingDesktops(now = Date.now()) {
  for (const list of [...registry.byUser.values()]) {
    for (const connection of list) {
      if (now - connection.lastSeen > 2 * DESKTOP_PING_MS) {
        connection.transport.close(4408, "Timeout");
        drop(connection);
        continue;
      }
      try {
        connection.transport.send({ type: "ping" });
      } catch {
        drop(connection);
      }
    }
  }
}

function startPinging() {
  if (registry.pinger) return;
  registry.pinger = setInterval(() => pingDesktops(), DESKTOP_PING_MS);
  registry.pinger.unref?.();
}

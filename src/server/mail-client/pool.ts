import type { ImapFlow } from "imapflow";
import type { mailbox } from "@/db/schema";
import { AccessError } from "@/server/access";
import { connectError, openImap } from "@/server/row-mail/connect";
import { RowMailError } from "@/server/row-mail/settings";
import { withMailCredentials } from "@/server/row-mail/credentials";

/**
 * IMAP connections per mailbox for what its owner does in the Mail tab, kept open between clicks
 * (signing in again takes a second or more) and closed when idle. Commands on a connection run one
 * after another: IMAP has one selected folder per connection. Each mailbox has two: `open` for what
 * the person waits on (a message, a file, a move), `background` for reading folders and loading
 * ahead, so a click never waits behind those. Kept on globalThis, as Next's bundle and server.ts
 * are separate module graphs in one process.
 */

type Box = typeof mailbox.$inferSelect;
export type ImapLane = "open" | "background";
type Entry = {
  key: string;
  client: Promise<ImapFlow>;
  queue: Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  usedAt: number;
  /** The folder selected when the last work ended. */
  selected?: string;
};

/** A connection nobody used for this long is closed; a few minutes of reading is the common gap. */
const IDLE_MS = 5 * 60_000;
/** Until then it says NOOP this often: some servers drop a quiet connection well before the 30 minutes IMAP allows. */
const KEEP_ALIVE_MS = 25_000;
const LANES: ImapLane[] = ["open", "background"];
const g = globalThis as typeof globalThis & { __leafdeskMailPool?: Map<string, Entry> };
const pool = (g.__leafdeskMailPool ??= new Map<string, Entry>());

/**
 * New servers or a new password open a new connection. Not `updatedAt`: the minute sweep and
 * Google's token renewals change it, and a connection signed in with a renewed token still works.
 */
const keyOf = (box: Box) =>
  JSON.stringify([box.imapHost, box.imapPort, box.imapSecure, box.username, box.auth, box.auth === "password" ? box.secret : null]);
const slot = (mailboxId: string, lane: ImapLane) => `${mailboxId}:${lane}`;

function close(at: string) {
  const entry = pool.get(at);
  if (!entry) return;
  pool.delete(at);
  if (entry.timer) clearTimeout(entry.timer);
  // What is still queued on it finishes first.
  void entry.queue.finally(() => entry.client.then((client) => client.logout().catch(() => client.close())).catch(() => {}));
}

function entryFor(box: Box, lane: ImapLane): Entry {
  const at = slot(box.id, lane);
  const existing = pool.get(at);
  if (existing && existing.key === keyOf(box)) return existing;
  if (existing) close(at);
  const started = performance.now();
  const client = withMailCredentials(box, openImap);
  const entry: Entry = { key: keyOf(box), client, queue: Promise.resolve(), timer: null, usedAt: Date.now() };
  client.then(
    () => console.info(`[mail-client] ${lane} connection to mailbox ${box.id} in ${Math.round(performance.now() - started)} ms`),
    // A connection that failed to open is not kept.
    () => pool.get(at) === entry && pool.delete(at),
  );
  pool.set(at, entry);
  return entry;
}

/**
 * Runs `work` on the mailbox's connection of `lane`, after what runs on it already. A connection
 * that broke is opened again once; what the server refused is thrown as connectError words it.
 */
export function withImap<T>(box: Box, work: (client: ImapFlow) => Promise<T>, lane: ImapLane = "open"): Promise<T> {
  const at = slot(box.id, lane);
  const first = entryFor(box, lane);
  let entry = first;
  const run = first.queue.then(async () => {
    if (entry.timer) clearTimeout(entry.timer);
    let client: ImapFlow | null = null;
    try {
      client = await entry.client;
      if (!client.usable) {
        close(at);
        entry = entryFor(box, lane);
        client = await entry.client;
      }
      return await work(client);
    } catch (error) {
      // What the work refused on its own terms (a file too large, a message gone) stays as it is.
      if (error instanceof RowMailError || error instanceof AccessError) throw error;
      const e = error as { code?: string };
      // A dropped connection: the next call opens a new one.
      if (e?.code === "NoConnection" || e?.code === "EConnectionClosed" || /closed|ECONNRESET|socket/i.test(String((error as Error)?.message))) close(at);
      throw connectError(error);
    } finally {
      entry.usedAt = Date.now();
      entry.selected = client?.mailbox ? client.mailbox.path : undefined;
      if (pool.get(at) === entry) idle(at, entry);
    }
  });
  first.queue = run.catch(() => {});
  return run;
}

/** Keeps a connection nobody is using open with NOOPs, and closes it once IDLE_MS have passed. */
function idle(at: string, entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (pool.get(at) !== entry) return;
    if (Date.now() - entry.usedAt >= IDLE_MS) return close(at);
    const ping = entry.queue.then(() => entry.client.then((client) => client.noop()));
    entry.queue = ping.catch(() => {});
    void ping.then(
      () => pool.get(at) === entry && !entry.timer && idle(at, entry),
      () => pool.get(at) === entry && close(at),
    );
  }, KEEP_ALIVE_MS);
  // Scripts end without waiting for it.
  entry.timer.unref?.();
}

/** Signs in on the mailbox's `open` connection ahead of the first click, with the folder shown selected. */
export function warmImap(box: Box, path: string) {
  const entry = pool.get(slot(box.id, "open"));
  if (entry && entry.key === keyOf(box) && entry.selected === path) return;
  void withImap(box, async (client) => {
    const lock = await client.getMailboxLock(path);
    lock.release();
  }).catch(() => {});
}

/** Closes the mailbox's connections (it was disconnected or changed). */
export const closeImap = (mailboxId: string) => LANES.forEach((lane) => close(slot(mailboxId, lane)));

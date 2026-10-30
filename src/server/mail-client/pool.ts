import type { ImapFlow } from "imapflow";
import type { mailbox } from "@/db/schema";
import { AccessError } from "@/server/access";
import { connectError, openImap } from "@/server/row-mail/connect";
import { RowMailError } from "@/server/row-mail/settings";
import { withMailCredentials } from "@/server/row-mail/credentials";

/**
 * One IMAP connection per mailbox for what its owner does in the Mail tab, kept open a little
 * between clicks (signing in again takes a second or more) and closed when idle. Commands on a
 * mailbox run one after another: IMAP has one selected folder per connection. Kept on globalThis,
 * as Next's bundle and server.ts are separate module graphs in one process.
 */

type Box = typeof mailbox.$inferSelect;
type Entry = { key: string; client: Promise<ImapFlow>; queue: Promise<unknown>; timer: ReturnType<typeof setTimeout> | null };

const IDLE_MS = 30_000;
const g = globalThis as typeof globalThis & { __leafdeskMailPool?: Map<string, Entry> };
const pool = (g.__leafdeskMailPool ??= new Map<string, Entry>());

/** A new sign-in or new servers open a new connection. */
const keyOf = (box: Box) => `${box.id}:${box.updatedAt.getTime()}`;

function close(id: string) {
  const entry = pool.get(id);
  if (!entry) return;
  pool.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  entry.client.then((client) => client.logout().catch(() => client.close())).catch(() => {});
}

function entryFor(box: Box): Entry {
  const existing = pool.get(box.id);
  if (existing && existing.key === keyOf(box)) return existing;
  if (existing) close(box.id);
  const client = withMailCredentials(box, openImap);
  const entry: Entry = { key: keyOf(box), client, queue: Promise.resolve(), timer: null };
  // A connection that failed to open is not kept.
  client.catch(() => pool.get(box.id) === entry && pool.delete(box.id));
  pool.set(box.id, entry);
  return entry;
}

/**
 * Runs `work` on the mailbox's connection, after what runs on it already. A connection that broke
 * is opened again once; what the server refused is thrown as connectError words it.
 */
export function withImap<T>(box: Box, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const first = entryFor(box);
  let entry = first;
  const run = first.queue.then(async () => {
    if (entry.timer) clearTimeout(entry.timer);
    try {
      let client = await entry.client;
      if (!client.usable) {
        close(box.id);
        entry = entryFor(box);
        client = await entry.client;
      }
      return await work(client);
    } catch (error) {
      // What the work refused on its own terms (a file too large, a message gone) stays as it is.
      if (error instanceof RowMailError || error instanceof AccessError) throw error;
      const e = error as { code?: string };
      // A dropped connection: the next call opens a new one.
      if (e?.code === "NoConnection" || e?.code === "EConnectionClosed" || /closed|ECONNRESET|socket/i.test(String((error as Error)?.message))) close(box.id);
      throw connectError(error);
    } finally {
      if (pool.get(box.id) === entry) entry.timer = setTimeout(() => close(box.id), IDLE_MS);
    }
  });
  first.queue = run.catch(() => {});
  return run;
}

/** Closes the mailbox's connection (it was disconnected or changed). */
export const closeImap = (mailboxId: string) => close(mailboxId);

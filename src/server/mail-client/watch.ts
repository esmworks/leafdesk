import { and, eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { db } from "@/db";
import { mailbox, mailFolder } from "@/db/schema";
import { MAIL_PAGE } from "@/lib/mail-client";
import { openImap } from "@/server/row-mail/connect";
import { withMailCredentials } from "@/server/row-mail/credentials";
import { indexFolder } from "./indexer";
import { withImap } from "./pool";
import { folderRefreshed } from "./read";

/**
 * New mail as it comes, for the Mail tabs open on a mailbox: one more connection per mailbox, apart
 * from the pool's (whose NOOPs and closing when unused would end IDLE), with the inbox selected and
 * IDLE running. What the server says changed there (mail come or gone, flags) is read into the
 * index on the pool's background lane, after the sweep's and the tabs' own reads, and announced to
 * those listening (api/mail/events). Only while someone listens, and a little after the last one
 * goes, as a reload comes back. A server without IDLE gets NOOPs every two minutes (imapflow), and
 * a quiet socket a NOOP when it would time out, which ends IDLE: the loop starts it again.
 */

export type MailChange = { mailboxId: string; folderId: string };
type Listener = (change: MailChange) => void;
type Watch = { listeners: Set<Listener>; client: ImapFlow | null; stopping: ReturnType<typeof setTimeout> | null; stopped: boolean };

/** How long a watch outlives its last listener. */
const GRACE_MS = 30_000;
/** Changes coming together (a message and its flags, several moved at once) are read once, this long after the last. */
const SETTLE_MS = 1_000;
/** Waits before connecting again after a dropped or refused connection, longer each time. */
const RETRY_MS = [5_000, 30_000, 120_000, 600_000];

const g = globalThis as typeof globalThis & { __leafdeskMailWatches?: Map<string, Watch> };
const watches = (g.__leafdeskMailWatches ??= new Map<string, Watch>());

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

async function inboxOf(mailboxId: string) {
  const [box] = await db.select().from(mailbox).where(eq(mailbox.id, mailboxId));
  const [inbox] = box ? await db.select().from(mailFolder).where(and(eq(mailFolder.mailboxId, box.id), eq(mailFolder.role, "inbox"))) : [];
  return box && inbox ? { box, inbox } : null;
}

/** Reads the inbox's changes into the index, then tells the listeners (they read the list again either way). */
async function changed(mailboxId: string, watch: Watch) {
  const found = await inboxOf(mailboxId).catch(() => null);
  if (!found) return;
  const { box, inbox } = found;
  try {
    await withImap(box, (client) => indexFolder(client, box, inbox, MAIL_PAGE * 2), "background");
    folderRefreshed(inbox.id);
  } catch (error) {
    console.warn(`[mail-client] reading mailbox ${mailboxId}'s inbox after a change failed:`, (error as Error)?.message ?? error);
  }
  for (const listener of watch.listeners) listener({ mailboxId, folderId: inbox.id });
}

async function run(mailboxId: string, watch: Watch) {
  let failures = 0;
  while (!watch.stopped) {
    let client: ImapFlow | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await inboxOf(mailboxId);
      // Gone, or not read for the first time yet: tried again later.
      if (found) {
        const { box, inbox } = found;
        client = await withMailCredentials(box, openImap);
        watch.client = client;
        if (!watch.stopped) {
          await client.mailboxOpen(inbox.path, { readOnly: true });
          const soon = () => {
            clearTimeout(settle);
            settle = setTimeout(() => void changed(mailboxId, watch), SETTLE_MS);
          };
          client.on("exists", soon);
          client.on("expunge", soon);
          client.on("flags", soon);
          failures = 0;
          while (!watch.stopped && client.usable) {
            const began = Date.now();
            await client.idle();
            // IDLE that ends at once (refused, or the folder no longer selected) is not started again in a tight loop.
            if (Date.now() - began < 1_000) await pause(1_000);
          }
        }
      }
    } catch (error) {
      console.warn(`[mail-client] watching mailbox ${mailboxId}'s inbox:`, (error as Error)?.message ?? error);
    } finally {
      clearTimeout(settle);
      watch.client = null;
      if (client) await client.logout().catch(() => client?.close());
    }
    if (!watch.stopped) await pause(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
  }
}

function stop(mailboxId: string, watch: Watch) {
  if (watches.get(mailboxId) === watch) watches.delete(mailboxId);
  watch.stopped = true;
  if (watch.stopping) clearTimeout(watch.stopping);
  // Ends IDLE; the loop logs out and ends.
  watch.client?.close();
}

/** Calls `listener` with each change the mailbox's inbox has, until the function returned is called. */
export function watchMailbox(mailboxId: string, listener: Listener): () => void {
  let watch = watches.get(mailboxId);
  if (!watch) {
    watch = { listeners: new Set(), client: null, stopping: null, stopped: false };
    watches.set(mailboxId, watch);
    void run(mailboxId, watch);
  }
  if (watch.stopping) clearTimeout(watch.stopping);
  watch.stopping = null;
  watch.listeners.add(listener);
  const held = watch;
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size || held.stopped) return;
    held.stopping = setTimeout(() => stop(mailboxId, held), GRACE_MS);
    held.stopping.unref?.();
  };
}

/** Stops watching the mailbox now, listeners or not (scripts, and a mailbox removed). */
export function stopWatching(mailboxId: string) {
  const watch = watches.get(mailboxId);
  if (watch) stop(mailboxId, watch);
}

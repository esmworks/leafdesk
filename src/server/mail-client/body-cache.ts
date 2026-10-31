import type { MailBody } from "@/lib/mail-client";

/**
 * Messages read from the mail server lately, held in this process's memory for a few minutes so
 * that opening one again, or one loaded ahead, doesn't wait for the server. Never written
 * anywhere. Keyed by the message's row in the index (one folder's copy) and whether its HTML loads
 * images from other sites; who may read it is checked before anything is served from here.
 */

const TTL_MS = 10 * 60_000;
const MAX_BYTES = 64 * 1024 * 1024;

type Held = { body: MailBody; bytes: number; until: number };
type Loading = { body: Promise<MailBody>; started: boolean };
type Cache = { held: Map<string, Held>; bytes: number; loading: Map<string, Loading> };
const g = globalThis as typeof globalThis & { __leafdeskMailBodies?: Cache };
const cache = (g.__leafdeskMailBodies ??= { held: new Map(), bytes: 0, loading: new Map() });

const keyOf = (messageId: string, images: boolean) => `${messageId}:${images ? 1 : 0}`;
const sizeOf = (body: MailBody) => (body.text.length + (body.html?.length ?? 0)) * 2 + 1024;

function drop(key: string) {
  const held = cache.held.get(key);
  if (!held) return;
  cache.held.delete(key);
  cache.bytes -= held.bytes;
}

function hold(key: string, body: MailBody) {
  drop(key);
  const bytes = sizeOf(body);
  if (bytes > MAX_BYTES / 8) return;
  cache.held.set(key, { body, bytes, until: Date.now() + TTL_MS });
  cache.bytes += bytes;
  // The oldest go first (a Map keeps insertion order).
  for (const [old] of cache.held) {
    if (cache.bytes <= MAX_BYTES) break;
    drop(old);
  }
}

/**
 * The message's body from memory, or read by `load`, which calls `started` once it talks to the
 * server. A read already talking to the server is waited for; one still queued behind other work
 * (loading ahead) is not, unless `queued` says it may be.
 */
export function heldBody(
  messageId: string,
  images: boolean,
  load: (started: () => void) => Promise<MailBody>,
  { queued = true }: { queued?: boolean } = {},
): { body: Promise<MailBody>; from: "memory" | "loading" | "server" } {
  const key = keyOf(messageId, images);
  const held = cache.held.get(key);
  if (held && held.until > Date.now()) {
    // Used again: it goes to the end, last to be dropped.
    cache.held.delete(key);
    cache.held.set(key, held);
    return { body: Promise.resolve(held.body), from: "memory" };
  }
  drop(key);
  const loading = cache.loading.get(key);
  if (loading && (loading.started || queued)) return { body: loading.body, from: "loading" };
  const entry = { started: false } as Loading;
  entry.body = load(() => (entry.started = true)).then((value) => {
    hold(key, value);
    return value;
  });
  // A read that doesn't wait for a queued one takes its place: what comes later waits for it.
  cache.loading.set(key, entry);
  void entry.body.finally(() => cache.loading.get(key) === entry && cache.loading.delete(key)).catch(() => {});
  return { body: entry.body, from: "server" };
}

/** Whether the message's body is in memory or on its way there. */
export const bodyHeld = (messageId: string, images: boolean) => {
  const key = keyOf(messageId, images);
  return (cache.held.get(key)?.until ?? 0) > Date.now() || cache.loading.has(key);
};

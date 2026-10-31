"use client";

import { read } from "@/components/read";
import type { MailBody, MailThreadView } from "@/lib/mail-client";

/**
 * Threads and messages this tab has read, so that going back to one shows it at once (a thread is
 * still read again behind it: mail may have come since), and the messages the server was asked to
 * load ahead.
 */

const MAX = 200;
const threads = new Map<string, MailThreadView>();
const bodies = new Map<string, MailBody>();
const asked = new Set<string>();

function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX) map.delete(map.keys().next().value!);
}

const threadKey = (mailboxId: string, folderId: string, threadId: string) => `${mailboxId}|${folderId}|${threadId}`;
const bodyKey = (messageId: string, images: boolean) => `${messageId}:${images ? 1 : 0}`;

export const cachedThread = (mailboxId: string, folderId: string, threadId: string) => threads.get(threadKey(mailboxId, folderId, threadId)) ?? null;
export const keepThread = (mailboxId: string, folderId: string, thread: MailThreadView) => keep(threads, threadKey(mailboxId, folderId, thread.threadId), thread);
export const cachedBody = (messageId: string, images: boolean) => bodies.get(bodyKey(messageId, images)) ?? null;
export const keepBody = (messageId: string, images: boolean, body: MailBody) => keep(bodies, bodyKey(messageId, images), body);

/** Asks the server to load these messages into its memory ahead of a click, each once per tab. */
export function loadAhead(messageIds: (string | null | undefined)[]) {
  const fresh = messageIds.filter((id): id is string => !!id && !asked.has(id) && !bodies.has(bodyKey(id, false)));
  if (!fresh.length) return;
  for (const id of fresh) asked.add(id);
  void read("mailAhead", { ids: fresh }).catch(() => fresh.forEach((id) => asked.delete(id)));
}

/**
 * What a push message about new mail says (server/mail-client/notify.ts), the part that needs no
 * server. Who wrote, never the subject or text: a lock screen shows it to whoever holds the device.
 */

import type { PushPayload, PushTranslator } from "./push";

/** A message just come into a mailbox's inbox. */
export type NewMail = { id: string; threadId: string; folderId: string; fromName: string | null; fromAddress: string };

/** Senders named in a message about several; the rest are counted. */
const NAMED = 2;

/**
 * One push message about the mail a pass found: a single message opens its thread in the Mail tab,
 * several the inbox. Each message has its own notification; several replace the last such message
 * from the mailbox. No buttons: Mark as read and Snooze answer inbox items. Null for no mail.
 */
export function mailPushPayload(box: { id: string; workspaceId: string; address: string }, mail: NewMail[], t: PushTranslator): PushPayload | null {
  const first = mail[0];
  if (!first) return null;
  const sender = (m: NewMail) => m.fromName?.trim() || m.fromAddress || t("someone");
  const at = new URLSearchParams({ box: box.id, f: first.folderId });
  if (mail.length === 1) {
    at.set("t", first.threadId);
    return { title: sender(first), body: `${t("newMail")} · ${box.address}`, url: `/w/${box.workspaceId}/mail?${at}`, tag: `mail:${first.id}`, read: "", snooze: "" };
  }
  const names = [...new Set(mail.map(sender))];
  return {
    title: t("newMailCount", { count: mail.length }),
    body: `${t("people", { name: names.slice(0, NAMED).join(", "), others: Math.max(0, names.length - NAMED) })} · ${box.address}`,
    url: `/w/${box.workspaceId}/mail?${at}`,
    tag: `mail:${box.id}`,
    read: "",
    snooze: "",
  };
}

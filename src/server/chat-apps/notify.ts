import { createHash } from "node:crypto";
import { createTranslator } from "next-intl";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notification } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { telegramMessages } from "@/i18n/messages/telegram";
import { env } from "@/lib/env";
import { formatIsoDate } from "@/lib/mentions";
import { pushPayload } from "@/lib/push";
import { escapeHtml } from "@/lib/telegram-format";
import { AccessError, ConnectedAppReadOnlyError, workspacesHiddenFromApp } from "@/server/access";
import { asWrite, runAsConnectedApp } from "@/server/connected-app";
import { ApprovalError, decideApproval } from "@/server/connections/approvals";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { getNotificationPreferences, telegramWanted } from "@/server/notification-preferences";
import { listNotifications, markRead, snoozeNotification, type InboxApproval, type InboxItem } from "@/server/notifications";
import { notifiedLinks, setChatNotifications } from "./links";
import { send, type Chat } from "./say";
import { ChannelError, type Buttons, type ChatChannel } from "./transport";
import { anyChatApp, transportOf } from "./transports";

/**
 * Inbox notifications in chat apps: each new one also goes, as a message, to each chat its
 * recipient linked (links.ts) in a chat app set up here, when they left notifications on there and
 * the kind on in their preferences (user_preference's `…Telegram` columns, which now mean every
 * chat app and follow the inbox as push does). Called
 * with the push notifications (server/push.ts), after the notification is saved; it never holds up
 * or fails what caused it.
 *
 * A message says what a push notification says (lib/push.ts pushPayload: the page and who did
 * what, never what a comment, a value or an email says, since a lock screen shows it to whoever
 * holds the phone), names the workspace, links to where the inbox leads, and has buttons to mark it
 * read or snooze it for an hour. The chat is a connected app's: notifications of a workspace that
 * turned connected apps off don't go there. A chat that blocked the bot gets nothing more: its
 * notifications are turned off until the person turns them on again in the settings.
 *
 * An agent's call waiting for an owner comes with what it would send, as the inbox shows it
 * (credentials masked, cut short) and hidden until tapped, so a lock screen doesn't show it; and
 * with Approve (only when that is all of what would be sent, as in the inbox), Decline and Send back
 * with a note. Answers go through decideApproval as the owner, held to the workspace's
 * connected-apps setting as a write: a workspace that lets apps only read is answered in the app.
 */

export async function deliverChatApps(ids: string[]): Promise<void> {
  if (!ids.length || !anyChatApp()) return;
  const rows = await db
    .select({ id: notification.id, userId: notification.userId, kind: notification.kind, locale: notification.emailLocale })
    .from(notification)
    .where(and(inArray(notification.id, ids), isNull(notification.readAt)));
  if (!rows.length) return;
  const links = await notifiedLinks([...new Set(rows.map((r) => r.userId))]);
  await Promise.all(
    links.map(async (link) => {
      const transport = transportOf(link.channel);
      if (!transport) return;
      const chat: Chat = { transport, id: link.chatId };
      const preferences = await getNotificationPreferences(link.userId);
      const theirs = rows.filter((r) => r.userId === link.userId && telegramWanted(preferences, r.kind));
      if (!theirs.length) return;
      const items = await runAsConnectedApp({ userId: link.userId }, async () => {
        const [listed, hidden] = await Promise.all([
          listNotifications(link.userId, { ids: theirs.map((r) => r.id), unreadOnly: true }),
          workspacesHiddenFromApp(link.userId),
        ]);
        return listed.filter((item) => !hidden.has(item.workspaceId));
      });
      if (!items.length) return;
      const texts = notifyTexts(await recipientLocale(link.userId, theirs.find((r) => r.locale)?.locale));
      for (const item of items) {
        const message = itemMessage(item, texts);
        if (!message) continue;
        try {
          await send(chat, message.text, message.buttons);
        } catch (error) {
          // The person blocked the bot or deleted the chat; stop until they turn it on again.
          if (error instanceof ChannelError && error.kind === "blocked") {
            await setChatNotifications(link.channel, link.userId, false);
            return;
          }
          throw error;
        }
      }
    }),
  );
}

type NotifyTexts = ReturnType<typeof notifyTexts>;

/** What a notification's message is written with, in the person's language: made once for all of theirs. */
function notifyTexts(locale: Locale) {
  const te = emailTranslator(locale);
  const push = (key: string, values?: Record<string, string | number>) => te(`push.${key}` as Parameters<typeof te>[0], values);
  return { locale, push, t: createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram.notify" }) };
}

/** A notification as a chat message: what its push notification says, with its buttons; null for one that has none. */
function itemMessage(item: InboxItem, { locale, push, t }: NotifyTexts): { text: string; buttons: Buttons } | null {
  const payload = pushPayload(item, push, (date, timeZone) => formatIsoDate(date, locale, "medium", timeZone));
  if (!payload) return null;
  if (item.approval) return approvalMessage(item, item.approval, payload, t);
  const text = [
    `<b>${escapeHtml(payload.title)}</b>`,
    escapeHtml(payload.body),
    `<i>${escapeHtml(item.workspaceName)}</i> · <a href="${escapeHtml(`${env.appUrl}${payload.url}`)}">${escapeHtml(t("open"))}</a>`,
  ].join("\n");
  const buttons: Buttons = [
    [
      { text: t("markRead"), data: `nr:${item.id}` },
      ...(payload.snooze ? [{ text: payload.snooze, data: `nz:${item.id}` }] : []),
    ],
  ];
  return { text, buttons };
}

/**
 * Sends the person the approval message of the call a run waits on for them, as deliverChatApps
 * would (for a chat with an agent from a chat app whose person doesn't get their notifications
 * there). False when they have no such notification: the run waits on someone else, or was answered.
 * Runs inside the person's connected-app call.
 */
export async function sendApprovalHere(userId: string, chat: Chat, runId: string): Promise<boolean> {
  const [found] = await db
    .select({ id: notification.id, locale: notification.emailLocale })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.agentRunId, runId), eq(notification.kind, "agent_approval")))
    .limit(1);
  if (!found) return false;
  const [item] = await listNotifications(userId, { ids: [found.id] });
  const message = item?.approval ? itemMessage(item, notifyTexts(await recipientLocale(userId, found.locale))) : null;
  if (!message) return false;
  await send(chat, message.text, message.buttons);
  return true;
}

/** How long the Snooze button puts a notification away for, as in the inbox's quickest choice. */
export const SNOOZE_MS = 60 * 60_000;

/**
 * A notification's button pressed in a chat app: marks it read, or snoozes it for SNOOZE_MS. False
 * when it isn't the person's or no longer can be (gone, or in a workspace they left or that
 * turned connected apps off).
 */
export async function answerNotification(userId: string, notificationId: string, action: "read" | "snooze"): Promise<boolean> {
  const [found] = await db
    .select({ workspaceId: notification.workspaceId })
    .from(notification)
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
    .limit(1);
  if (!found) return false;
  return runAsConnectedApp({ userId }, async () => {
    if ((await workspacesHiddenFromApp(userId)).has(found.workspaceId)) return false;
    if (action === "snooze") return snoozeNotification(userId, notificationId, new Date(Date.now() + SNOOZE_MS));
    try {
      await markRead(userId, found.workspaceId, [notificationId]);
      return true;
    } catch (error) {
      if (error instanceof AccessError) return false;
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------- agents' calls

/** The most of a call's input a message shows: a longer call is approved from its run. */
export const CALL_CHARS = 3_000;

/**
 * A short fingerprint of the call a message shows, carried by its buttons (Telegram keeps a button's
 * data to 64 bytes): an answer to an earlier call of the run is refused rather than taken.
 */
export const callGuard = (callId: string) => createHash("sha256").update(callId).digest("hex").slice(0, 10);

/** What a message shows of a call, and whether that is all of what would be sent. */
export function shownCall(approval: Pick<InboxApproval, "input" | "whole">): { input: string; whole: boolean } {
  const cut = approval.input.length > CALL_CHARS;
  return { input: cut ? `${approval.input.slice(0, CALL_CHARS - 1)}…` : approval.input, whole: approval.whole && !cut };
}

type NotifyTranslator = (key: "approve" | "decline" | "redo" | "notWhole" | "openRun") => string;

function approvalMessage(item: InboxItem, approval: InboxApproval, payload: { title: string; body: string; url: string }, t: NotifyTranslator) {
  const { input, whole } = shownCall(approval);
  const text = [
    `<b>${escapeHtml(payload.title)}</b>`,
    escapeHtml(payload.body),
    `<tg-spoiler>${escapeHtml(input)}</tg-spoiler>`,
    ...(whole ? [] : [`<i>${escapeHtml(t("notWhole"))}</i>`]),
    `<i>${escapeHtml(item.workspaceName)}</i> · <a href="${escapeHtml(`${env.appUrl}${payload.url}`)}">${escapeHtml(t("openRun"))}</a>`,
  ].join("\n");
  const data = (choice: string) => `a${choice}:${item.id}:${callGuard(approval.callId)}`;
  const buttons: Buttons = [
    [...(whole ? [{ text: t("approve"), data: data("a") }] : []), { text: t("decline"), data: data("d") }],
    [{ text: t("redo"), data: data("r") }],
  ];
  return { text, buttons };
}

/** How an answer to an agent's call from a chat app went (`telegram.notify.call.*`). */
export type CallAnswer = "approved" | "declined" | "sentBack" | "decided" | "gone" | "changed" | "forbidden" | "readOnly" | "notWhole" | "emptyNote";

/**
 * An owner's answer from a chat app (`via`, for the audit log) to the call an approval notification
 * shows: `guard` (callGuard) names the call they saw. Approving needs the call shown whole, as in
 * the inbox.
 */
export async function answerCall(
  userId: string,
  notificationId: string,
  guard: string,
  decision: "approve" | "decline" | "redo",
  via: ChatChannel,
  note?: string,
): Promise<CallAnswer> {
  if (decision === "redo" && !note?.trim()) return "emptyNote";
  const [found] = await db
    .select({ workspaceId: notification.workspaceId, kind: notification.kind })
    .from(notification)
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
    .limit(1);
  // An answered call's notifications are gone (withdrawApproval), and someone else's aren't theirs to answer.
  if (!found || found.kind !== "agent_approval") return "gone";
  return runAsConnectedApp({ userId }, async () => {
    if ((await workspacesHiddenFromApp(userId)).has(found.workspaceId)) return "gone";
    const [item] = await listNotifications(userId, { ids: [notificationId] });
    const approval = item?.approval;
    if (!approval) return "gone";
    if (callGuard(approval.callId) !== guard) return "changed";
    if (decision === "approve" && !shownCall(approval).whole) return "notWhole";
    try {
      await asWrite(() => decideApproval(userId, { runId: approval.runId, callId: approval.callId, decision, note, via }));
      return decision === "approve" ? "approved" : decision === "decline" ? "declined" : "sentBack";
    } catch (error) {
      if (error instanceof ApprovalError) return error.code === "decided" ? "decided" : error.code === "forbidden" ? "forbidden" : error.code === "invalid" ? "emptyNote" : "gone";
      if (error instanceof ConnectedAppReadOnlyError) return "readOnly";
      if (error instanceof AccessError) return "gone";
      throw error;
    }
  });
}

/**
 * What a push message about an AI chat answer that finished while no page of the person's followed
 * it says (server/ai-chat-notices.ts), the part that needs no server. Not what was asked or
 * answered: a lock screen shows it to whoever holds the device.
 */

import { chatPath } from "./ai-chat";
import type { PushPayload, PushTranslator } from "./push";

/**
 * The answer in conversation `conversationId` is there: opens the conversation. A later answer
 * there replaces the message. No buttons: Mark as read and Snooze answer inbox items.
 */
export function chatAnsweredPayload(at: { workspaceId: string; conversationId: string }, t: PushTranslator): PushPayload {
  return {
    title: t("chatAnsweredTitle"),
    body: t("chatAnswered"),
    url: chatPath(at.workspaceId, at.conversationId),
    tag: `chat:${at.conversationId}`,
    read: "",
    snooze: "",
  };
}

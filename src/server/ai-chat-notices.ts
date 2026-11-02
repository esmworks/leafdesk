/**
 * Telling the person about their AI chat answer when no page of theirs follows it
 * (ai-chat-runs.ts followedIn): one that asks them about a change leaves an inbox item of kind
 * `ai_chat_waiting` (pushed and sent to Telegram like any other), gone once they decide or the
 * run goes; one that finishes sends a push message only, under the same kind's push choice. Only
 * the person's own chat in the app: an answer asked through a connected app (the Telegram bot)
 * is followed there, and a request of their own on a schedule reports through its schedule.
 * Never throws: telling is no part of the answer.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { notification } from "@/db/schema";
import type { AssistantRunSource } from "@/lib/agents";
import { chatAnsweredPayload } from "@/lib/chat-push";
import { getNotificationPreferences, pushWanted } from "@/server/notification-preferences";
import { signalInbox } from "@/server/notifications";
import { pushNotifications, pushToPerson } from "@/server/push";

/** Whether the person hears about this answer of theirs away from its page. */
export const tellsPerson = (source: AssistantRunSource) => !source.fromApp && !source.scheduleId;

/** The answer (run `runId`) waits for the person's decision: once per run while it waits. */
export async function noteChatWaiting(userId: string, workspaceId: string, runId: string) {
  try {
    const [there] = await db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.agentRunId, runId), eq(notification.kind, "ai_chat_waiting")))
      .limit(1);
    if (there) return;
    const [made] = await db.insert(notification).values({ userId, workspaceId, kind: "ai_chat_waiting", actorId: null, agentRunId: runId }).returning({ id: notification.id });
    signalInbox(workspaceId);
    pushNotifications([made.id]);
  } catch (error) {
    console.error("[ai] could not tell about a chat answer waiting", error);
  }
}

/** The person decided (or the answer stopped waiting some other way): its inbox item goes. */
export async function dropChatWaiting(runId: string) {
  try {
    const gone = await db
      .delete(notification)
      .where(and(eq(notification.agentRunId, runId), eq(notification.kind, "ai_chat_waiting")))
      .returning({ workspaceId: notification.workspaceId });
    if (gone.length) signalInbox(gone[0].workspaceId);
  } catch (error) {
    console.error("[ai] could not take back a chat answer waiting", error);
  }
}

/** The answer in the conversation is there: a push to the person's devices, when they want those. */
export async function pushChatAnswered(userId: string, workspaceId: string, conversationId: string) {
  try {
    if (!pushWanted(await getNotificationPreferences(userId), "ai_chat_waiting")) return;
    pushToPerson(userId, workspaceId, (t) => chatAnsweredPayload({ workspaceId, conversationId }, t));
  } catch (error) {
    console.error("[ai] could not push a chat answer", error);
  }
}

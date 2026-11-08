/**
 * Mentioning an agent in a channel of Messages: a member's message (a new one or a reply) that
 * names an agent in the channel queues a run of it (`agent_run`, source `channel`), held to the
 * member's access as well as its own. The run answers in the message's thread, as the agent
 * (server/agents/run.ts), so everyone in the channel reads the answer.
 *
 * The agent must be in the channel: its people brought it in, or a member named it there
 * (`agentsToBringIn`: sendMessage adds it before storing the message), and only then does a
 * mention reach it (`message_mention` holds only those inside). Only a person's message by name
 * starts a run: never @here or @channel, an agent's own message (its answers included: agents
 * can't set each other off), a guest's, an edit that adds a mention, or a direct conversation.
 * Paused agents still get the run, which answers that they are paused; archived ones none.
 *
 * Called after a message is stored (messages/posts.ts sendMessage), never inside its transaction.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMessage, messageMention, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { plainText } from "@/lib/message-text";
import { findMembership, isGuest } from "@/server/access";
import { startTriggered } from "@/server/triggers";
import { agentLevels } from "./sharing";
import { isAgentUser } from "./users";

/**
 * A message this old or older starts nothing: only one just written asks an agent anything (a
 * message brought in from elsewhere, or sent again from a client's retry long after, doesn't).
 */
const FRESH_MS = 2 * 60_000;

/**
 * Of the people a member's message names, the agents it brings into the channel, so that they
 * answer: live ones shared with the writer. Naming an agent is asking it; the writer may add
 * people anyway, and the channel shows who brought it in. Guests bring none.
 */
export async function agentsToBringIn(authorId: string, workspaceId: string, role: Parameters<typeof isGuest>[0], userIds: string[]): Promise<string[]> {
  if (!userIds.length || isGuest(role)) return [];
  const agents = await db
    .select({ id: workspaceAgent.id, userId: workspaceAgent.userId })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), inArray(workspaceAgent.userId, userIds), isNull(workspaceAgent.archivedAt)));
  if (!agents.length) return [];
  const levels = await agentLevels(authorId, workspaceId, agents.map((a) => a.id), role);
  return agents.filter((a) => levels.get(a.id) !== "none").map((a) => a.userId);
}

/** Queues a run of each agent the message names that may answer there. Returns the queued runs' ids. */
export async function startChannelMentionRuns(messageId: string): Promise<string[]> {
  const [row] = await db
    .select({ message: channelMessage, kind: channel.kind, archivedAt: channel.archivedAt })
    .from(channelMessage)
    .innerJoin(channel, eq(channel.id, channelMessage.channelId))
    .where(eq(channelMessage.id, messageId))
    .limit(1);
  if (!row) return [];
  const { message } = row;
  if (message.kind !== "message" || message.deletedAt || !message.authorId || row.kind === "direct" || row.archivedAt) return [];
  if (Date.now() - message.createdAt.getTime() > FRESH_MS) return [];
  // Named by name, and in the channel: @here and @channel are kept as `broadcast` mentions.
  const named = await db
    .select({ userId: messageMention.userId })
    .from(messageMention)
    .where(and(eq(messageMention.messageId, message.id), eq(messageMention.broadcast, false)));
  if (!named.length) return [];
  const authorId = message.authorId;
  if (await isAgentUser(authorId)) return [];
  const membership = await findMembership(authorId, message.workspaceId);
  if (!membership || isGuest(membership.role)) return [];
  const agents = await db
    .select({ id: workspaceAgent.id })
    .from(workspaceAgent)
    .where(
      and(
        eq(workspaceAgent.workspaceId, message.workspaceId),
        inArray(
          workspaceAgent.userId,
          named.map((n) => n.userId),
        ),
        isNull(workspaceAgent.archivedAt),
      ),
    );
  if (!agents.length) return [];
  const levels = await agentLevels(authorId, message.workspaceId, agents.map((a) => a.id), membership.role);
  const shared = agents.filter((a) => levels.get(a.id) !== "none");
  const queued: string[] = [];
  for (const agent of shared) {
    const { run } = await startTriggered({
      target: { agentId: agent.id },
      workspaceId: message.workspaceId,
      source: { kind: "channel", channelId: message.channelId, threadId: message.threadId ?? message.id, messageId: message.id, mentionedBy: authorId },
      context: { actorId: authorId },
      prompt: plainText(message.body).slice(0, MAX_AGENT_PROMPT),
    });
    queued.push(run.id);
  }
  return queued;
}

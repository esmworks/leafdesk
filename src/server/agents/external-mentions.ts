/**
 * Mentions of outside agents (agents of kind `external`, see external.ts). They never run here, so
 * a comment that mentions one is kept for it (`external_agent_mention`) until it marks it handled.
 * A leaf module: agents/mentions.ts (which server/comments.ts uses) calls it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { externalAgentMention, PAGE_LEVELS, workspaceAgent } from "@/db/schema";
import { mentionExcerpt } from "@/lib/external-agents";

const COMMENT_RANK = PAGE_LEVELS.indexOf("comment");

/**
 * Keeps a new comment's mention for each of these outside agents that may comment on the page (as
 * the one mentioned would have to). A comment recorded twice is one mention.
 */
export async function recordExternalMentions(input: {
  agentIds: string[];
  authorId: string;
  workspaceId: string;
  pageId: string;
  threadId: string;
  commentId: string;
  text: string;
}) {
  if (!input.agentIds.length) return;
  const commenting = await db
    .select({ id: workspaceAgent.id })
    .from(workspaceAgent)
    .where(and(inArray(workspaceAgent.id, input.agentIds), sql`page_access_level(${workspaceAgent.userId}, ${input.pageId}) >= ${COMMENT_RANK}`));
  if (!commenting.length) return;
  await db
    .insert(externalAgentMention)
    .values(
      commenting.map((a) => ({
        agentId: a.id,
        workspaceId: input.workspaceId,
        pageId: input.pageId,
        threadId: input.threadId,
        commentId: input.commentId,
        mentionedBy: input.authorId,
        excerpt: mentionExcerpt(input.text),
      })),
    )
    .onConflictDoNothing();
}

/** Takes back the open mentions of a deleted comment or thread (`commentId` left out: the whole thread). */
export async function withdrawExternalMentions(pageId: string, threadId: string, commentId?: string) {
  await db
    .delete(externalAgentMention)
    .where(
      and(
        eq(externalAgentMention.pageId, pageId),
        eq(externalAgentMention.threadId, threadId),
        commentId ? eq(externalAgentMention.commentId, commentId) : undefined,
        sql`${externalAgentMention.handledAt} is null`,
      ),
    );
}

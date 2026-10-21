/**
 * Mentioning an agent in a comment: the @ menu of a page's comments offers the agents that may
 * comment on the page, and a member who posts a comment (a new thread or a reply) mentioning one
 * queues a run of it (`agent_run`, source `mention`). The run answers in the thread, as the agent
 * (server/agents/run.ts), held to the member's access as well as its own.
 *
 * Only members start runs: a guest's mention (and an agent's own reply, which never carries
 * mentions anyway) starts none, and an edit that adds a mention starts none either. Paused and
 * archived agents aren't offered; one paused since answers that it is paused.
 *
 * A leaf module: server/comments.ts uses it, and the run worker imports server/comments.ts.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, PAGE_LEVELS, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { searchFold } from "@/lib/search-fold";
import { findMembership, isGuest } from "@/server/access";
import { requestLocale } from "@/server/mail/locale";
import { kickAgents } from "./kick";
import { isAgentUser } from "./users";

/** An agent as the comments' @ menu offers it: its user (what a mention names), name and icon. */
export type AgentCandidate = { id: string; name: string; icon: string | null };

const COMMENT_RANK = PAGE_LEVELS.indexOf("comment");

/** SQL: the agent's user may at least comment on the page. */
const commentsOn = (pageId: string) => sql`page_access_level(${workspaceAgent.userId}, ${pageId}) >= ${COMMENT_RANK}`;

/**
 * The agents of the workspace a comment on the page may mention, matching `q` (folded, see
 * lib/search-fold): on, not archived, and allowed to comment on the page.
 */
export async function mentionableAgents(workspaceId: string, pageId: string, q: string): Promise<AgentCandidate[]> {
  const rows = await db
    .select({ id: workspaceAgent.userId, name: workspaceAgent.name, icon: workspaceAgent.icon })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt), eq(workspaceAgent.enabled, true), commentsOn(pageId)))
    .orderBy(asc(workspaceAgent.name));
  return rows.filter((a) => !q || searchFold(a.name).includes(q));
}

/**
 * Queues a run of each agent a new comment mentions (`mentioned`: the users it mentions, people and
 * agents alike) that is in the workspace, not archived and may comment on the page; an agent
 * mentioned twice runs once. Nothing when the author is a guest, not in the workspace, or an agent.
 * Returns the queued runs' ids.
 */
export async function startMentionRuns(input: {
  authorId: string;
  workspaceId: string;
  pageId: string;
  threadId: string;
  commentId: string;
  mentioned: string[];
  /** The comment's text: the run's task. */
  text: string;
}): Promise<string[]> {
  const mentioned = [...new Set(input.mentioned)];
  if (!mentioned.length) return [];
  // An agent's comment never starts a run, whatever it says: agents can't set each other off.
  if (await isAgentUser(input.authorId)) return [];
  const membership = await findMembership(input.authorId, input.workspaceId);
  if (!membership || isGuest(membership.role)) return [];
  const agents = await db
    .select({ id: workspaceAgent.id })
    .from(workspaceAgent)
    .where(
      and(
        eq(workspaceAgent.workspaceId, input.workspaceId),
        inArray(workspaceAgent.userId, mentioned),
        isNull(workspaceAgent.archivedAt),
        commentsOn(input.pageId),
      ),
    );
  if (!agents.length) return [];
  const locale = await requestLocale();
  const queued = await db
    .insert(agentRun)
    .values(
      agents.map((agent) => ({
        agentId: agent.id,
        workspaceId: input.workspaceId,
        source: { kind: "mention" as const, pageId: input.pageId, threadId: input.threadId, commentId: input.commentId, mentionedBy: input.authorId },
        context: { actorId: input.authorId, locale },
        prompt: input.text.slice(0, MAX_AGENT_PROMPT),
      })),
    )
    .returning({ id: agentRun.id });
  kickAgents();
  return queued.map((r) => r.id);
}

import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import {
  cleanCommentBody,
  CommentError,
  commentMentions,
  commentText,
  isReactionEmoji,
  replyAudience,
  threadParticipants,
  type CommentAnchor,
  type CommentOp,
  type PlainThread,
} from "@/lib/comments";
import { AccessError, getMembership, hasLevel, isGuest, requirePageAccess, resolvePageAccess } from "@/server/access";
import { avatarSrc } from "@/lib/avatar";
import { getCollab } from "@/server/collab/bridge";
import type { CommentOpResult } from "@/server/collab/bridge";
import { reactionTarget } from "@/lib/comment-reactions";
import { recordComment, recordReaction, withdrawComments, withdrawReaction, withdrawReactions } from "@/server/notifications";
import { newThreadAudience } from "@/server/page-watch";
import { followOnTakingPart } from "@/server/row-follow";
import { forgetThreadMutes, threadMuters, unmuteThread } from "@/server/thread-mute";
import { forgetThreadStates } from "@/server/thread-state";
import { workspacePeople } from "@/server/workspaces";
import { agentMarks, markOf } from "@/server/agents/users";
import { startMentionRuns } from "@/server/agents/mentions";
import { redactError } from "@/lib/redact";

/**
 * Comments on pages. Anyone who can view a page reads its comments; anyone who can comment on it
 * (the "comment" level, or edit and full access) writes them. People with full access may also delete other people's comments and whole threads, like
 * BlockNote's "editor" role; everyone else edits and deletes only their own.
 *
 * Every change goes through the server, which writes it into the page's live document, so browsers
 * never write comments themselves and who wrote what can be trusted.
 */

/** Someone in a page's comments. Agents (see server/agents) are marked, with their icon. */
export type CommentUser = { id: string; username: string; avatarUrl: string; isAgent: boolean; agentIcon: string | null };

function cleanEmoji(emoji: unknown): string {
  if (!isReactionEmoji(emoji)) throw new CommentError("A reaction is one emoji", "invalidBody");
  return emoji;
}

const id = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 100) throw new CommentError("That comment doesn't exist anymore", "notFound");
  return value;
};

const MAX_QUOTE = 1000;
/** Announced on a row's database channel after a change to the row's comments. */
export const COMMENTS_EVENT = "comments";

function cleanAnchor(anchor: unknown): CommentAnchor | undefined {
  if (anchor === undefined || anchor === null) return undefined;
  const a = anchor as Partial<CommentAnchor>;
  if (typeof a.quote !== "string" || !a.quote.trim() || a.quote.length > MAX_QUOTE) {
    throw new CommentError(`Quote up to ${MAX_QUOTE} characters of the page`, "invalidBody");
  }
  return {
    quote: a.quote,
    ...(typeof a.blockId === "string" && a.blockId.length <= 100 ? { blockId: a.blockId } : {}),
    ...(Number.isInteger(a.offset) && a.offset! >= 0 ? { offset: a.offset } : {}),
  };
}

/** The change as the page stores it: known fields only, bodies cleaned, ids and emoji checked. */
function cleanOp(op: CommentOp): CommentOp {
  switch (op?.type) {
    case "createThread": {
      const anchor = cleanAnchor(op.anchor);
      return { type: "createThread", body: cleanCommentBody(op.body), ...(anchor ? { anchor } : {}) };
    }
    case "addComment":
      return { type: "addComment", threadId: id(op.threadId), body: cleanCommentBody(op.body) };
    case "updateComment":
      return { type: "updateComment", threadId: id(op.threadId), commentId: id(op.commentId), body: cleanCommentBody(op.body) };
    case "deleteComment":
    case "addReaction":
    case "deleteReaction":
      if (op.type === "deleteComment") return { type: op.type, threadId: id(op.threadId), commentId: id(op.commentId) };
      return { type: op.type, threadId: id(op.threadId), commentId: id(op.commentId), emoji: cleanEmoji(op.emoji) };
    case "deleteThread":
    case "resolveThread":
    case "unresolveThread":
      return { type: op.type, threadId: id(op.threadId) };
    default:
      throw new CommentError("Unknown comment change", "invalidBody");
  }
}

/** The page's comment threads, oldest first. */
export async function listComments(userId: string, pageId: string): Promise<PlainThread[]> {
  await requirePageAccess(userId, pageId, "view");
  return getCollab().readThreads(pageId);
}

/**
 * Applies one comment change for `userId`. A new thread's anchor marks the text it is about (see
 * CommentAnchor); the server marks it, so people who may only comment never write the page.
 * Throws AccessError without comment access and CommentError for changes that can't be made.
 */
export async function changeComments(userId: string, pageId: string, op: CommentOp): Promise<CommentOpResult> {
  const { page: target, level } = await resolvePageAccess(userId, pageId);
  if (!target || !hasLevel(level, "comment")) throw new AccessError();
  if (target.archivedAt) throw new CommentError("Pages in the trash can't be commented on", "notAllowed");
  // Mentions are read before cleaning, which keeps only their names. A stored comment holds no
  // mention nodes, so those in an edit are the people it newly mentions.
  const mentioned = op?.type === "addComment" || op?.type === "createThread" || op?.type === "updateComment" ? commentMentions(op.body) : [];
  const clean = cleanOp(op);
  const role = hasLevel(level, "full") ? "editor" : "comment";
  const result = await getCollab().commentOp(pageId, { userId, role }, clean);

  if ((clean.type === "createThread" || clean.type === "addComment") && result.thread && result.comment) {
    // Everyone who wrote in the thread before hears about a reply, but those who muted it (see
    // server/thread-mute); a new thread tells the page's watchers (a database row's followers), see
    // server/page-watch. People a comment mentions hear about it either way.
    let recipients: string[];
    if (clean.type === "createThread") recipients = [...(await newThreadAudience(pageId, target.createdBy)), ...mentioned];
    else {
      const audience = replyAudience({
        participants: threadParticipants(result.thread, userId, result.comment.id),
        muted: await threadMuters(pageId, result.thread.id),
        mentioned,
        authorId: userId,
      });
      await unmuteThread(pageId, result.thread.id, audience.unmute);
      recipients = audience.notify;
    }
    await recordComment(userId, target.workspaceId, pageId, result.thread.id, recipients);
    // Commenting on a database row follows it (server/row-follow).
    await followOnTakingPart(pageId, [userId]);
    // Agents it mentions answer in the thread (server/agents/mentions); an edit starts none.
    await startMentionRuns({
      authorId: userId,
      workspaceId: target.workspaceId,
      pageId,
      threadId: result.thread.id,
      commentId: result.comment.id,
      mentioned,
      text: commentText(clean.body),
    }).catch((error) => console.error("[comments] could not start the runs of agents a comment mentions", redactError(error)));
  } else if (clean.type === "updateComment" && mentioned.length) {
    // People an edit mentions hear about it like any other mention, and it ends their mute.
    await unmuteThread(pageId, clean.threadId, mentioned);
    await recordComment(userId, target.workspaceId, pageId, clean.threadId, mentioned);
  } else if (clean.type === "addReaction" || clean.type === "deleteReaction") {
    // The comment's author hears about reactions by others (server/notifications recordReaction).
    const reaction = reactionTarget(result.thread, clean.commentId, userId, clean.emoji);
    if (reaction) {
      const about = { pageId, threadId: clean.threadId, commentId: clean.commentId, authorId: reaction.authorId, emoji: clean.emoji };
      if (clean.type === "addReaction" && reaction.reacted) await recordReaction(userId, target.workspaceId, { ...about, excerpt: reaction.excerpt });
      else if (clean.type === "deleteReaction" && !reaction.reacted) await withdrawReaction(userId, target.workspaceId, about);
    }
  } else if (clean.type === "deleteThread" || (clean.type === "deleteComment" && !result.thread)) {
    await withdrawComments(target.workspaceId, pageId, clean.threadId);
    await forgetThreadMutes(pageId, clean.threadId);
    await forgetThreadStates(pageId, clean.threadId);
  } else if (clean.type === "deleteComment") {
    // Reactions to a deleted comment are about nothing any more.
    await withdrawReactions(target.workspaceId, pageId, clean.threadId, clean.commentId);
  }
  // A row's comments show in its database's feed views (components/database/feed-view).
  if (target.parentId) getCollab().broadcast(`db:${target.parentId}`, COMMENTS_EVENT);
  return result;
}

/**
 * Names and pictures of people in the page's comments, for BlockNote's comment UI: anyone who wrote
 * or reacted in its threads (they may have left since, or be agents) and, for members, people in
 * the workspace. Guests only learn about the people in the threads, as with person properties.
 */
export async function commentUsers(userId: string, pageId: string, userIds: string[]): Promise<CommentUser[]> {
  const target = await requirePageAccess(userId, pageId, "view");
  const wanted = Array.isArray(userIds) ? [...new Set(userIds.filter((v) => typeof v === "string"))].slice(0, 200) : [];
  if (!wanted.length) return [];
  const threads = await getCollab().readThreads(pageId);
  const inThreads = new Set(
    threads.flatMap((t) => [...(t.resolvedBy ? [t.resolvedBy] : []), ...t.comments.flatMap((c) => [c.userId, ...c.reactions.flatMap((r) => r.userIds)])]),
  );
  const membership = await getMembership(userId, target.workspaceId);
  const members = new Set(
    membership && !isGuest(membership.role) ? (await workspacePeople(target.workspaceId)).map((p) => p.id) : [],
  );
  const allowed = wanted.filter((v) => members.has(v) || inThreads.has(v));
  if (!allowed.length) return [];
  const [rows, agents] = await Promise.all([
    db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, allowed)),
    agentMarks(allowed),
  ]);
  return rows.map((r) => ({ id: r.id, username: r.name, avatarUrl: avatarSrc(r.image) ?? "", ...markOf(agents, r.id) }));
}

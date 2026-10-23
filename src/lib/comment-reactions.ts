import { commentText, type PlainThread } from "./comments";

/**
 * Reactions to comments as their authors hear about them (server/notifications.ts recordReaction):
 * one unread notification per comment lists who reacted with what, growing as people react and
 * shrinking as they take a reaction back. Pure, so the rules are tested without a database.
 */

/** One person's reaction with one emoji. */
export type Reactor = { userId: string; emoji: string };

/** How much of the comment a reaction notification quotes. */
export const REACTION_EXCERPT_CHARS = 120;

/**
 * Whom a reaction by `reactorId` with `emoji` to comment `commentId` concerns, read from the thread
 * after the change: the comment's author (null when they reacted to their own comment, or the
 * comment is gone or deleted), whether the reaction is there now, and the start of the comment.
 */
export function reactionTarget(
  thread: Pick<PlainThread, "comments"> | undefined,
  commentId: string,
  reactorId: string,
  emoji: string,
): { authorId: string; reacted: boolean; excerpt: string } | null {
  const comment = thread?.comments.find((c) => c.id === commentId);
  if (!comment || comment.deletedAt || comment.userId === reactorId) return null;
  return {
    authorId: comment.userId,
    reacted: comment.reactions.some((r) => r.emoji === emoji && r.userIds.includes(reactorId)),
    excerpt: commentText(comment.body).replace(/\s+/g, " ").trim().slice(0, REACTION_EXCERPT_CHARS),
  };
}

const same = (a: Reactor, b: Reactor) => a.userId === b.userId && a.emoji === b.emoji;

/** The list with `reactor` added last (moved there when it was in it already). */
export function addReactor(list: readonly Reactor[], reactor: Reactor): Reactor[] {
  return [...list.filter((r) => !same(r, reactor)), { userId: reactor.userId, emoji: reactor.emoji }];
}

/** The list without `reactor`. */
export function removeReactor(list: readonly Reactor[], reactor: Reactor): Reactor[] {
  return list.filter((r) => !same(r, reactor));
}

/** Reactions as JSON stored them: entries of the right shape only. */
export function parseReactors(value: unknown): Reactor[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is Reactor => typeof r === "object" && r !== null && typeof (r as Reactor).userId === "string" && typeof (r as Reactor).emoji === "string",
  );
}

/** What a notification shows of its reactions: the emojis and the people, the latest first, each once. */
export function reactionSummary(list: readonly Reactor[]): { emojis: string[]; userIds: string[] } {
  const latest = [...list].reverse();
  return { emojis: [...new Set(latest.map((r) => r.emoji))], userIds: [...new Set(latest.map((r) => r.userId))] };
}

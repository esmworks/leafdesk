import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { page, pageReaction } from "@/db/schema";
import { isReactionEmoji } from "@/lib/comments";
import { MAX_REACTIONS_PER_PERSON, type PostReaction } from "@/lib/feed";
import { AccessError, hasLevel, pageVisibleTo, resolvePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";

/**
 * Emoji reactions to pages themselves (a feed view's posts, see lib/feed): anyone who can view a
 * page sees them, anyone who can comment on it (the "comment" level, or edit and full access)
 * reacts, as with reactions to its comments. Each person's reaction is theirs alone to take back.
 */

/** What a database's channel says when the reactions to one of its rows changed. */
export const REACTIONS_EVENT = "reactions";

export class ReactionError extends Error {
  constructor(
    message: string,
    readonly code: "invalidEmoji" | "tooMany" | "inTrash",
  ) {
    super(message);
    this.name = "ReactionError";
  }
}

/**
 * The reactions to pages already known to be visible to `viewerId`, by page id, each emoji in the
 * order it was first left. Pages without any are missing.
 */
export async function reactionsFor(viewerId: string, pageIds: string[]): Promise<Record<string, PostReaction[]>> {
  if (!pageIds.length) return {};
  const rows = await db
    .select({ pageId: pageReaction.pageId, userId: pageReaction.userId, emoji: pageReaction.emoji })
    .from(pageReaction)
    .where(inArray(pageReaction.pageId, pageIds))
    .orderBy(asc(pageReaction.createdAt), asc(pageReaction.userId));
  const out: Record<string, PostReaction[]> = {};
  for (const row of rows) {
    const list = (out[row.pageId] ??= []);
    let reaction = list.find((r) => r.emoji === row.emoji);
    if (!reaction) list.push((reaction = { emoji: row.emoji, count: 0, mine: false, userIds: [] }));
    reaction.count++;
    reaction.userIds.push(row.userId);
    if (row.userId === viewerId) reaction.mine = true;
  }
  return out;
}

/** The reactions to these pages that `userId` may see: pages they can't view are left out. */
export async function listReactions(userId: string, pageIds: string[]): Promise<Record<string, PostReaction[]>> {
  const ids = [...new Set(pageIds.filter((id) => typeof id === "string" && id.length <= 100))].slice(0, 200);
  if (!ids.length) return {};
  const visible = await db
    .select({ id: page.id })
    .from(page)
    .where(and(inArray(page.id, ids), pageVisibleTo(userId)));
  return reactionsFor(
    userId,
    visible.map((p) => p.id),
  );
}

/**
 * Leaves `emoji` on the page for `userId` (`on`), or takes theirs back, and returns the page's
 * reactions. Needs comment access; a page in the trash takes none. Open feeds of the page's
 * database hear of it on the database's channel.
 */
export async function setReaction(userId: string, pageId: string, emoji: unknown, on: boolean): Promise<PostReaction[]> {
  if (!isReactionEmoji(emoji)) throw new ReactionError("A reaction is one emoji", "invalidEmoji");
  const { page: target, level } = await resolvePageAccess(userId, pageId);
  if (!target || !hasLevel(level, "comment")) throw new AccessError();
  if (target.archivedAt) throw new ReactionError("Pages in the trash take no reactions", "inTrash");
  if (on) {
    const [{ value: mine }] = await db
      .select({ value: count() })
      .from(pageReaction)
      .where(and(eq(pageReaction.pageId, pageId), eq(pageReaction.userId, userId)));
    if (mine >= MAX_REACTIONS_PER_PERSON) {
      throw new ReactionError(`Up to ${MAX_REACTIONS_PER_PERSON} different reactions per person`, "tooMany");
    }
    await db.insert(pageReaction).values({ pageId, userId, emoji }).onConflictDoNothing();
  } else {
    await db
      .delete(pageReaction)
      .where(and(eq(pageReaction.pageId, pageId), eq(pageReaction.userId, userId), eq(pageReaction.emoji, emoji)));
  }
  if (target.parentId) getCollab().broadcast(`db:${target.parentId}`, REACTIONS_EVENT);
  return (await reactionsFor(userId, [pageId]))[pageId] ?? [];
}

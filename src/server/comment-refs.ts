import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import { commentText } from "@/lib/comments";
import { AccessError } from "@/server/access";
import { listComments } from "@/server/comments";
import { resolvePageRefs } from "@/server/mentions";

/**
 * What a reader sees of a comment thread another page points at (a comment mention or a comment
 * preview block, lib/comment-refs): its first comment's author, time and text, and the page it is
 * on. Worked out for the reader each time it is shown, with their access then: a thread on a page
 * they can't open, or one that is gone, reads the same ("none"), and nothing of it is sent.
 */

export type CommentRefKey = { pageId: string; threadId: string };

export type CommentRef =
  | {
      pageId: string;
      threadId: string;
      status: "ok";
      workspaceId: string;
      pageTitle: string;
      pageIcon: string | null;
      authorName: string;
      authorImage: string | null;
      createdAt: string;
      /** The first comment's text, up to EXCERPT characters. */
      text: string;
      replies: number;
      resolved: boolean;
    }
  | { pageId: string; threadId: string; status: "none" };

const MAX_REFS = 50;
const EXCERPT = 400;

const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,128}$/.test(value);

export async function resolveCommentRefs(userId: string, keys: CommentRefKey[]): Promise<CommentRef[]> {
  const wanted = (Array.isArray(keys) ? keys : []).filter((k) => k && validId(k.pageId) && validId(k.threadId)).slice(0, MAX_REFS);
  if (!wanted.length) return [];
  const pageIds = [...new Set(wanted.map((k) => k.pageId))];
  const pages = new Map((await resolvePageRefs(userId, pageIds)).map((ref) => [ref.id, ref]));
  const threads = new Map<string, Awaited<ReturnType<typeof listComments>>>();
  for (const pageId of pageIds) {
    if (pages.get(pageId)?.status !== "ok") continue;
    try {
      threads.set(pageId, await listComments(userId, pageId));
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
    }
  }
  const found = wanted.map((key) => {
    const thread = threads.get(key.pageId)?.find((t) => t.id === key.threadId);
    const first = thread?.comments.find((c) => !c.deletedAt) ?? null;
    return { key, thread, first };
  });
  const authorIds = [...new Set(found.flatMap(({ first }) => (first ? [first.userId] : [])))];
  const authors = new Map(
    authorIds.length
      ? (await db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, authorIds))).map((r) => [r.id, r])
      : [],
  );
  return found.map(({ key, thread, first }): CommentRef => {
    const page = pages.get(key.pageId);
    if (!thread || !first || page?.status !== "ok") return { ...key, status: "none" };
    const author = authors.get(first.userId);
    const text = commentText(first.body).replace(/\s+/g, " ").trim();
    return {
      ...key,
      status: "ok",
      workspaceId: page.workspaceId,
      pageTitle: page.title,
      pageIcon: page.icon,
      authorName: author?.name ?? "",
      authorImage: avatarSrc(author?.image),
      createdAt: first.createdAt,
      text: text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text,
      replies: Math.max(0, thread.comments.filter((c) => !c.deletedAt).length - 1),
      resolved: thread.resolved,
    };
  });
}

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, user } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import type { PlainComment, PlainThread } from "@/lib/comments";
import { FEED_BODY_CHARS, FEED_EXCERPT_CHARS, feedExcerpt, type PostReaction } from "@/lib/feed";
import { AccessError, childVisibleTo, getMembership, requirePageAccess } from "@/server/access";
import { agentMarks, markOf } from "@/server/agents/users";
import type { CommentUser } from "@/server/comments";
import { getCollab } from "@/server/collab/bridge";
import { labelPageLinks } from "@/server/mentions";
import { reactionsFor } from "@/server/reactions";

/**
 * What a feed view shows of its posts beyond the database's rows (see lib/feed): the first part of
 * each body, the reactions to it and its open comment threads, for the posts on screen only, read
 * with the viewer's access to each row. Comments are changed through server/comments.ts and
 * reactions through server/reactions.ts, as anywhere else.
 */

/** A comment as a post shows it; its reactions stay in the row's own comments. */
export type FeedComment = Pick<PlainComment, "id" | "userId" | "createdAt" | "updatedAt" | "body">;
/** An open thread of a row: about the whole row, or quoting some of its text. */
export type FeedThread = { id: string; quote: string | null; comments: FeedComment[] };
export type FeedPost = {
  id: string;
  /** Who wrote the post: the row's creator (an agent too), or null when unknown. */
  authorId: string | null;
  /** Markdown of the body's first blocks (lib/feed feedExcerpt), page links named for the viewer. */
  excerpt: string;
  /** The body goes on past the excerpt: "Show more" reads it (feedBody). */
  more: boolean;
  reactions: PostReaction[];
  threads: FeedThread[];
};
export type FeedPosts = {
  posts: FeedPost[];
  /** Names and pictures of the posts' authors and of who commented or reacted. */
  people: CommentUser[];
};

export type LinkLabels = { untitled: string; noAccess: string; deleted: string };

/** Posts asked for at once: a page of the feed, with room for a page that grew meanwhile. */
const MAX_POSTS = 50;
/** What is read of a body for its excerpt: more than it shows, so it can tell whether more follows. */
const EXCERPT_READ = FEED_EXCERPT_CHARS * 6;

/**
 * The posts `rowIds` of feed views of `databaseId`, in the order asked, for `userId`. Rows that
 * aren't the database's, or that they can't see, are left out; without access to the database,
 * AccessError.
 */
export async function feedPosts(userId: string, databaseId: string, rowIds: string[], labels?: LinkLabels): Promise<FeedPosts> {
  const database = await requirePageAccess(userId, databaseId, "view");
  if (database.kind !== "database") throw new AccessError();
  const ids = [...new Set(rowIds.filter((id) => typeof id === "string" && id.length <= 100))].slice(0, MAX_POSTS);
  if (!ids.length) return { posts: [], people: [] };
  const rows = await db
    .select({
      id: page.id,
      createdBy: page.createdBy,
      head: sql<string>`left(${page.contentMarkdown}, ${EXCERPT_READ})`,
      length: sql<number>`length(${page.contentMarkdown})`,
    })
    .from(page)
    .where(
      and(
        inArray(page.id, ids),
        eq(page.parentId, databaseId),
        eq(page.isTemplate, false),
        // A trashed database shows the rows that went to the trash with it (as getDatabaseSnapshot).
        database.archivedAt ? eq(page.archivedAt, database.archivedAt) : isNull(page.archivedAt),
        childVisibleTo(userId, databaseId),
      ),
    );
  const found = new Map(rows.map((r) => [r.id, r]));
  const visible = ids.filter((id) => found.has(id));
  const [reactions, threads] = await Promise.all([
    reactionsFor(userId, visible),
    Promise.all(visible.map((id) => getCollab().readThreads(id))),
  ]);
  const posts = await Promise.all(
    visible.map(async (id, i): Promise<FeedPost> => {
      const row = found.get(id)!;
      const excerpt = feedExcerpt(row.head);
      return {
        id,
        authorId: row.createdBy,
        excerpt: excerpt.markdown ? await labelPageLinks(userId, excerpt.markdown, labels) : "",
        more: excerpt.more || Number(row.length) > EXCERPT_READ,
        reactions: reactions[id] ?? [],
        threads: threads[i].flatMap(openThread),
      };
    }),
  );
  const people = await postPeople(userId, database.workspaceId, [
    ...rows.map((r) => r.createdBy),
    ...posts.flatMap((p) => [...p.reactions.flatMap((r) => r.userIds), ...p.threads.flatMap((t) => t.comments.map((c) => c.userId))]),
  ]);
  return { posts, people };
}

/** An open thread as a post shows it; resolved ones, and threads whose comments were all deleted, stay in the row. */
function openThread(thread: PlainThread): FeedThread[] {
  if (thread.resolved) return [];
  const comments = thread.comments.flatMap((c): FeedComment[] =>
    c.deletedAt || !c.body ? [] : [{ id: c.id, userId: c.userId, createdAt: c.createdAt, updatedAt: c.updatedAt, body: c.body }],
  );
  return comments.length ? [{ id: thread.id, quote: thread.page ? null : (thread.quote ?? null), comments }] : [];
}

/**
 * Who the posts name: their authors and the people in their reactions and threads, named to every
 * reader of the posts as comment authors are anywhere in the app (server/comments.ts commentUsers).
 */
async function postPeople(userId: string, workspaceId: string, userIds: (string | null)[]): Promise<CommentUser[]> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === "string" && !!id))].slice(0, 500);
  if (!ids.length || !(await getMembership(userId, workspaceId))) return [];
  const [rows, agents] = await Promise.all([
    db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, ids)),
    agentMarks(ids),
  ]);
  return rows.map((r) => ({ id: r.id, username: r.name, avatarUrl: avatarSrc(r.image) ?? "", ...markOf(agents, r.id) }));
}

/**
 * The whole body of a post as Markdown (up to FEED_BODY_CHARS), for "Show more"; `cut` when it was
 * longer. Page links are named for the viewer, as in get_page.
 */
export async function feedBody(userId: string, rowId: string, labels?: LinkLabels): Promise<{ markdown: string; cut: boolean }> {
  await requirePageAccess(userId, rowId, "view");
  const [row] = await db
    .select({
      body: sql<string>`left(${page.contentMarkdown}, ${FEED_BODY_CHARS})`,
      length: sql<number>`length(${page.contentMarkdown})`,
    })
    .from(page)
    .where(eq(page.id, rowId));
  if (!row) throw new AccessError();
  return { markdown: await labelPageLinks(userId, row.body, labels), cut: Number(row.length) > FEED_BODY_CHARS };
}

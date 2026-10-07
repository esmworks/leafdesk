/**
 * Comments on pages: threads of comments anchored to text, stored in the page's Yjs document in
 * BlockNote's format (a `threads` map) so they sync live like the text. Only the server writes
 * them (see server/comments.ts), so who wrote what can be trusted. A comment's body is a small
 * BlockNote document: paragraphs of styled text and links.
 */

/** The map in the page's document holding its threads, as BlockNote's thread stores expect. */
export const THREADS_MAP = "threads";

/** Longest comment, in characters of text. */
export const MAX_COMMENT_LENGTH = 10_000;
const MAX_PARAGRAPHS = 100;

/**
 * The text a new thread is about: `quote`, at `offset` in the text of block `blockId` when given
 * (a browser's selection), else where the page first has it. Non-text inline content (mentions)
 * counts as one U+FFFC character.
 */
export type CommentAnchor = { quote: string; blockId?: string; offset?: number };

export type CommentOp =
  | { type: "createThread"; body: unknown; anchor?: CommentAnchor }
  | { type: "addComment"; threadId: string; body: unknown }
  | { type: "updateComment"; threadId: string; commentId: string; body: unknown }
  | { type: "deleteComment"; threadId: string; commentId: string }
  | { type: "deleteThread"; threadId: string }
  | { type: "resolveThread"; threadId: string }
  | { type: "unresolveThread"; threadId: string }
  | { type: "addReaction"; threadId: string; commentId: string; emoji: string }
  | { type: "deleteReaction"; threadId: string; commentId: string; emoji: string };

/** A comment as plain data (dates as ISO strings), to cross the server boundary. */
export type PlainComment = {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** Set once the comment is deleted; its body is gone then. */
  deletedAt: string | null;
  body: CommentBody | null;
  reactions: { emoji: string; userIds: string[] }[];
};

export type PlainThread = {
  id: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  resolvedBy: string | null;
  comments: PlainComment[];
  /** The text the thread is anchored to; null when that text was deleted. Only set by the server. */
  quote?: string | null;
  /** The thread is about the whole page and quotes nothing (agents write these). Only set by the server. */
  page?: true;
};

type Styles = Partial<Record<(typeof STYLES)[number], true>>;
type Text = { type: "text"; text: string; styles: Styles };
type Inline = Text | { type: "link"; href: string; content: Text[] };
export type CommentBody = { type: "paragraph"; content: Inline[] }[];

const STYLES = ["bold", "italic", "underline", "strike", "code"] as const;

export class CommentError extends Error {
  constructor(
    message: string,
    readonly code: "invalidBody" | "tooLong" | "notFound" | "notAllowed",
  ) {
    super(message);
    this.name = "CommentError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Links in comments open web pages or write emails; anything else is dropped to its text. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 2000) return null;
  try {
    const url = new URL(href.trim());
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(node: unknown): Text | null {
  if (!isRecord(node) || node.type !== "text" || typeof node.text !== "string") return null;
  const styles: Styles = {};
  if (isRecord(node.styles)) for (const style of STYLES) if (node.styles[style] === true) styles[style] = true;
  return { type: "text", text: node.text, styles };
}

function cleanInline(node: unknown): Inline[] {
  if (typeof node === "string") return [{ type: "text", text: node, styles: {} }];
  if (isRecord(node) && node.type === "link") {
    const content = (Array.isArray(node.content) ? node.content : typeof node.content === "string" ? [node.content] : [])
      .flatMap((c) => (typeof c === "string" ? [{ type: "text" as const, text: c, styles: {} }] : (cleanText(c) ?? [])));
    const href = safeHref(node.href);
    return href ? [{ type: "link", href, content }] : content;
  }
  const text = cleanText(node);
  return text ? [text] : [];
}

/**
 * A comment body the way it is stored: paragraphs of text with bold, italic, underline, strike or
 * code, and web or email links. Other blocks, styles and attributes are left out; plain strings
 * become one paragraph per line. Throws CommentError for empty or overlong comments.
 */
export function cleanCommentBody(body: unknown): CommentBody {
  const blocks: unknown[] =
    typeof body === "string" ? body.split("\n").map((line) => ({ type: "paragraph", content: line })) : Array.isArray(body) ? body : [];
  if (blocks.length > MAX_PARAGRAPHS) throw new CommentError(`A comment has at most ${MAX_PARAGRAPHS} paragraphs`, "tooLong");
  const clean: CommentBody = blocks.flatMap((block) => {
    if (!isRecord(block) || (block.type !== undefined && block.type !== "paragraph")) return [];
    const content = typeof block.content === "string" ? [block.content] : Array.isArray(block.content) ? block.content : [];
    return [{ type: "paragraph" as const, content: content.flatMap(cleanInline) }];
  });
  const text = commentText(clean);
  if (!text.trim()) throw new CommentError("A comment needs some text", "invalidBody");
  if (text.length > MAX_COMMENT_LENGTH) throw new CommentError(`A comment has at most ${MAX_COMMENT_LENGTH} characters`, "tooLong");
  return clean;
}

/** A comment's text, one line per paragraph (links as their text). */
export function commentText(body: unknown): string {
  if (!Array.isArray(body)) return "";
  return body
    .map((block) => {
      if (!isRecord(block)) return "";
      const content = typeof block.content === "string" ? [block.content] : Array.isArray(block.content) ? block.content : [];
      return content
        .map((node) => {
          if (typeof node === "string") return node;
          if (!isRecord(node)) return "";
          if (node.type === "link") return commentText([{ content: node.content }]);
          return typeof node.text === "string" ? node.text : "";
        })
        .join("");
    })
    .join("\n");
}

/**
 * Who hears about a new comment in a thread: everyone who wrote a comment there before (deleted
 * ones included — they took part), except its author.
 */
export function threadParticipants(thread: Pick<PlainThread, "comments">, authorId: string, newCommentId?: string): string[] {
  const ids = thread.comments.filter((c) => c.id !== newCommentId).map((c) => c.userId);
  return [...new Set(ids)].filter((id) => id !== authorId);
}

type ThreadLike = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  resolved: boolean;
  resolvedBy?: string;
  comments: {
    id: string;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date;
    body: unknown;
    reactions: { emoji: string; userIds: string[] }[];
  }[];
};

const iso = (date: Date | undefined) => (date && !Number.isNaN(date.getTime()) ? date.toISOString() : null);

/** A BlockNote thread as plain data. */
export function plainThread(thread: ThreadLike): PlainThread {
  return {
    id: thread.id,
    createdAt: iso(thread.createdAt) ?? "",
    updatedAt: iso(thread.updatedAt) ?? "",
    resolved: !!thread.resolved,
    resolvedBy: thread.resolved ? (thread.resolvedBy ?? null) : null,
    comments: thread.comments.map(plainComment),
  };
}

export function plainComment(comment: ThreadLike["comments"][number]): PlainComment {
  return {
    id: comment.id,
    userId: comment.userId,
    createdAt: iso(comment.createdAt) ?? "",
    updatedAt: iso(comment.updatedAt) ?? "",
    deletedAt: iso(comment.deletedAt),
    body: comment.deletedAt ? null : (comment.body as CommentBody),
    reactions: comment.reactions.map((r) => ({ emoji: r.emoji, userIds: [...r.userIds] })),
  };
}

/** What a thread about the whole page (no text of it quoted, as agents write) carries as metadata. */
export const PAGE_THREAD_METADATA = { page: true } as const;

/** Whether a thread's metadata says it is about the whole page. */
export const isPageThread = (metadata: unknown) =>
  typeof metadata === "object" && metadata !== null && (metadata as { page?: unknown }).page === true;

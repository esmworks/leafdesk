/**
 * Comments on pages: threads of comments anchored to text, stored in the page's Yjs document in
 * BlockNote's format (a `threads` map) so they sync live like the text. Only the server writes
 * them (see server/comments.ts), so who wrote what can be trusted. A comment's body is a small
 * BlockNote document: paragraphs of styled text and links.
 */

/** The map in the page's document holding its threads, as BlockNote's thread stores expect. */
export const THREADS_MAP = "threads";

/**
 * A link's fragment for a thread of the page (`#comment-<id>`): the page opens its comments with
 * that thread selected and scrolls to the text it is about. Notifications about comments lead there.
 */
export const commentHash = (threadId: string) => `#comment-${threadId}`;
const COMMENT_HASH = /^#comment-([\w-]{1,100})$/;

/** The thread a link's fragment (`location.hash`) names, if it names one. */
export const threadOfHash = (hash: string): string | undefined => COMMENT_HASH.exec(hash)?.[1];

/** Longest reaction, in UTF-16 units: an emoji with its modifiers. */
const MAX_EMOJI = 32;

/** Whether `value` is one emoji (with its modifiers): what a reaction, to a comment or a page, is. */
export function isReactionEmoji(value: unknown): value is string {
  return typeof value === "string" && !!value && value.length <= MAX_EMOJI && !/\s/.test(value) && /\p{Extended_Pictographic}/u.test(value);
}

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
  /** The thread is about this suggested edit (lib/suggestions), opened by the server. Only set by the server. */
  suggestion?: string;
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
  // A person mentioned keeps their name as text (see commentMentions).
  if (isRecord(node) && node.type === "mention" && isRecord(node.props) && typeof node.props.name === "string" && node.props.name) {
    return [{ type: "text", text: `@${node.props.name}`, styles: {} }];
  }
  const text = cleanText(node);
  return text ? [text] : [];
}

/**
 * A comment body the way it is stored: paragraphs of text with bold, italic, underline, strike or
 * code, and web or email links. People mentioned become their name as text; other blocks, styles
 * and attributes are left out; plain strings become one paragraph per line. Throws CommentError for empty or overlong comments.
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

/**
 * A comment body as the comment box sends it, with page and date mentions turned into the text they
 * show: the page's title (`pageTitle`, nothing when unknown) or the date. Comments keep only people
 * mentioned (cleanCommentBody), and a mention pasted from a page would otherwise leave nothing.
 */
export function mentionsAsText(body: unknown, pageTitle: (pageId: string) => string | null): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((block) => {
    if (!isRecord(block) || !Array.isArray(block.content)) return block;
    const content = block.content.flatMap((node: unknown) => {
      if (!isRecord(node) || node.type !== "mention" || !isRecord(node.props) || node.props.kind === "user") return [node];
      const { kind, pageId, date } = node.props;
      const text = kind === "date" ? date : typeof pageId === "string" ? pageTitle(pageId) : null;
      return typeof text === "string" && text ? [{ type: "text", text, styles: {} }] : [];
    });
    return { ...block, content };
  });
}

/**
 * The people a comment's body mentions (`mention` nodes of kind "user", as on pages), before it is
 * cleaned: the stored body keeps only their names as text.
 */
export function commentMentions(body: unknown): string[] {
  const found = new Set<string>();
  if (!Array.isArray(body)) return [];
  for (const block of body) {
    if (!isRecord(block) || !Array.isArray(block.content)) continue;
    for (const node of block.content) {
      if (!isRecord(node) || node.type !== "mention" || !isRecord(node.props)) continue;
      const { kind, userId } = node.props;
      if (kind === "user" && typeof userId === "string" && userId && userId.length <= 100) found.add(userId);
    }
  }
  return [...found];
}

/**
 * Who hears about a reply, and whose mute of the thread it ends: the people in the thread but
 * those who muted it, and the people it mentions whether they muted it or not. Posting in a thread,
 * or being mentioned there, unmutes it, so nothing addressed to someone is missed.
 */
export function replyAudience({
  participants,
  muted,
  mentioned,
  authorId,
}: {
  participants: string[];
  muted: string[];
  mentioned: string[];
  authorId: string;
}): { notify: string[]; unmute: string[] } {
  const silent = new Set(muted);
  const notify = new Set([...participants.filter((id) => !silent.has(id)), ...mentioned]);
  notify.delete(authorId);
  const unmute = [...new Set([authorId, ...mentioned])].filter((id) => silent.has(id));
  return { notify: [...notify], unmute };
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

/**
 * The suggested edit (lib/suggestions) a thread is about, if it is one's: the server opens one for
 * each, in its author's name, and resolves it once the suggestion is answered or withdrawn.
 */
export const suggestionOfThread = (metadata: unknown): string | null => {
  const id = typeof metadata === "object" && metadata !== null ? (metadata as { suggestion?: unknown }).suggestion : undefined;
  return typeof id === "string" ? id : null;
};

/** The title of the row a thread came from when that row was merged into this one, if it did. */
export const mergedFromOf = (metadata: unknown): string | null => {
  const from = typeof metadata === "object" && metadata !== null ? (metadata as { mergedFrom?: unknown }).mergedFrom : undefined;
  return typeof from === "string" ? from : null;
};

/**
 * A thread up to one of its comments as an agent mentioned there reads it: the comments before
 * `commentId` (deleted ones left out), each as "<name>: <text>", oldest first; the last `max` of
 * them, as many as fit in `chars` from the newest back. Empty when the comment isn't in the thread.
 */
export function threadBefore(
  thread: Pick<PlainThread, "comments">,
  commentId: string,
  nameOf: (userId: string) => string,
  { max, chars }: { max: number; chars: number },
): string[] {
  const at = thread.comments.findIndex((c) => c.id === commentId);
  if (at < 0) return [];
  const lines = thread.comments
    .slice(0, at)
    .filter((c) => !c.deletedAt && c.body)
    .slice(-max)
    .map((c) => `${nameOf(c.userId)}: ${commentText(c.body).trim()}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i].length + 1;
    if (used > chars) break;
    kept.unshift(lines[i]);
  }
  return kept;
}

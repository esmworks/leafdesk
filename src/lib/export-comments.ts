import { commentImages, commentText, type CommentBody, type CommentParagraph, type PlainThread } from "@/lib/comments";

/**
 * A page's comment threads in an export (Markdown, the ZIP's page files, the PDF), after the page:
 * one entry per thread, saying what it is about (the text it quotes, the whole page, a property's
 * value, or text since removed) and whether it is resolved, then its comments oldest first, each
 * with its author and when it was written (UTC, the same for every reader). Deleted comments are
 * left out, and a thread with nothing left in it too. Reactions stay in the app.
 *
 * Pure: the caller passes only the threads the exporter may see (server/property-comments.ts
 * `threadsVisibleTo`) and their authors' names.
 */

export type CommentExportLabels = {
  /** The section's heading ("Comments"). */
  heading: string;
  /** A thread on some text, quoting it. */
  quote: (text: string) => string;
  page: string;
  property: (name: string) => string;
  /** A thread whose text was deleted from the page since. */
  removed: string;
  suggestion: string;
  resolved: string;
  /** An author whose name isn't known any more. */
  unknown: string;
};

export const ENGLISH_COMMENT_LABELS: CommentExportLabels = {
  heading: "Comments",
  quote: (text) => `“${text}”`,
  page: "About this page",
  property: (name) => `On “${name}”`,
  removed: "On text that was removed",
  suggestion: "Suggested edit",
  resolved: "Resolved",
  unknown: "Someone",
};

export type ExportedComment = { author: string; date: string; body: CommentBody };
export type ExportedThread = { about: string; resolved: boolean; comments: ExportedComment[] };

/** The longest quote a thread's heading shows, in characters. */
const MAX_QUOTE = 120;

/** A quote on one line, cut to MAX_QUOTE characters. */
export function shortQuote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_QUOTE ? `${line.slice(0, MAX_QUOTE - 1).trimEnd()}…` : line;
}

/** An ISO time as `YYYY-MM-DD HH:MM UTC`; "" when it isn't one. */
export function commentDate(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function aboutOf(thread: PlainThread, labels: CommentExportLabels): string {
  if (thread.property) return labels.property(thread.property.name);
  if (thread.quote) return labels.quote(shortQuote(thread.quote));
  if (thread.suggestion) return labels.suggestion;
  if (thread.page || thread.quote === undefined) return labels.page;
  return labels.removed;
}

/** The threads as an export shows them, oldest first; `nameOf` gives an author's name, if known. */
export function exportedThreads(threads: PlainThread[], nameOf: (userId: string) => string | undefined, labels: CommentExportLabels): ExportedThread[] {
  return [...threads]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((thread) => {
      const comments = thread.comments.flatMap((c): ExportedComment[] =>
        c.deletedAt || !c.body || (!commentText(c.body).trim() && !commentImages(c.body).length) ? [] : [{ author: nameOf(c.userId) || labels.unknown, date: commentDate(c.createdAt), body: c.body }],
      );
      return comments.length ? [{ about: aboutOf(thread, labels), resolved: thread.resolved, comments }] : [];
    });
}

/** Text as Markdown shows it literally. */
export const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>~|]/g, "\\$&");

/** A paragraph's start that Markdown would read as a heading, list, quote or rule. */
const BLOCK_START = /^(\s*)([#>+-]|\d+[.)])/;

/** A link target Markdown keeps whole. */
const linkTarget = (href: string) => href.replace(/[()\s]/g, (c) => encodeURIComponent(c));

/** Code as Markdown shows it: in enough backticks that none inside ends it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/**
 * A comment's body as Markdown, one string per paragraph (line breaks in it kept as "\n"): bold,
 * italic, struck-through, code and links kept, anything else Markdown would read escaped.
 */
export function commentMarkdown(body: CommentBody): string[] {
  const styled = (node: { text: string; styles: Record<string, unknown> }) => {
    if (!node.text) return "";
    // Each line apart: emphasis doesn't run across a line break.
    return node.text
      .split("\n")
      .map((part) => {
        if (!part) return "";
        if (node.styles.code) return codeSpan(part);
        let text = escapeMarkdown(part);
        if (node.styles.bold) text = `**${text}**`;
        if (node.styles.italic) text = `*${text}*`;
        if (node.styles.strike) text = `~~${text}~~`;
        return text;
      })
      .join("\n");
  };
  const paragraphMarkdown = (paragraph: CommentParagraph) =>
    (Array.isArray(paragraph.content) ? paragraph.content : [])
      .map((node) => {
        if (node.type === "link") return `[${node.content.map(styled).join("").replace(/\n/g, " ")}](${linkTarget(node.href)})`;
        if (node.type === "mention") return escapeMarkdown(node.props.date);
        return styled(node);
      })
      .join("")
      .split("\n")
      .map((line) => line.replace(BLOCK_START, (_, space: string, mark: string) => `${space}${/\d/.test(mark) ? `${mark.slice(0, -1)}\\${mark.slice(-1)}` : `\\${mark}`}`))
      .join("\n");
  // Images a line each, numbered.
  return body.map((block) =>
    block.type === "images"
      ? commentImages([block])
          .map((url, i) => `![${i + 1}](${url})`)
          .join("\n")
      : paragraphMarkdown(block),
  );
}

/** A comment's paragraphs as a Markdown quote: hard line breaks inside them, an empty quote line between. */
function quoted(paragraphs: string[]): string {
  return paragraphs.map((p) => p.split("\n").map((line) => (line ? `> ${line}` : ">")).join("  \n")).join("\n>\n");
}

/**
 * The threads as a Markdown section to put after a page's body: a rule, the heading, then each
 * thread under a heading saying what it is about, its comments as quotes under their author and
 * date. "" without threads.
 */
export function commentsMarkdown(threads: ExportedThread[], labels: CommentExportLabels): string {
  if (!threads.length) return "";
  const parts = threads.map((thread) => {
    const head = [`### ${escapeMarkdown(thread.about)}`, ...(thread.resolved ? [`*${escapeMarkdown(labels.resolved)}*`] : [])];
    const comments = thread.comments.map((c) => {
      const byline = `**${escapeMarkdown(c.author)}**${c.date ? ` · ${c.date}` : ""}`;
      return `${byline}\n\n${quoted(commentMarkdown(c.body))}`;
    });
    return [...head, ...comments].join("\n\n");
  });
  return `---\n\n## ${escapeMarkdown(labels.heading)}\n\n${parts.join("\n\n")}`;
}

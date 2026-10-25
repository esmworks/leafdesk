import { commentHash, threadOfHash } from "./comments";
import { pagePath } from "./mentions";

/**
 * Pointing at a comment thread from a page: a link to it (`/w/<ws>/p/<page>#comment-<thread>`,
 * "Copy link" in a thread's menu) pasted into a page of the same workspace can become a comment
 * mention (inline: who wrote it and what they wrote, a `mention` of kind "comment", lib/mentions)
 * or a comment preview block (author, time, page and text, with a link that opens the thread).
 * Like page mentions, only ids are stored; what a reader sees is worked out for them when it is
 * shown (server/comment-refs.ts), and a thread they can't see shows "No access", never its text.
 * Published pages show neither. Shared by the editor and the server (server/blocknote.ts).
 *
 * Markdown: a mention is a link to the thread, `[Page](/w/<ws>/p/<page>#comment-<thread>)`; a
 * preview block is that link alone on its line followed by COMMENT_PREVIEW_MARKER.
 */

export const COMMENT_PREVIEW_BLOCK = "commentPreview";
export const COMMENT_PREVIEW_MARKER = "<!-- leafdesk:comment -->";

export const commentPreviewBlockConfig = {
  type: COMMENT_PREVIEW_BLOCK,
  propSchema: { pageId: { default: "" }, threadId: { default: "" } },
  content: "none",
} as const;

/** The address of a thread of a page. */
export const commentPath = (workspaceId: string, pageId: string, threadId: string) => `${pagePath(workspaceId, pageId)}${commentHash(threadId)}`;

const ID = "[\\w-]{1,128}";

/**
 * The workspace, page and thread a link to a comment thread of this app points at (relative, or on
 * the app's origin `appUrl`), or null for any other link.
 */
export function linkedCommentRef(href: unknown, appUrl?: string): { workspaceId: string; pageId: string; threadId: string } | null {
  if (typeof href !== "string") return null;
  let value = href.trim();
  if (appUrl) {
    const origin = appUrl.replace(/\/+$/, "");
    if (value.toLowerCase().startsWith(origin.toLowerCase() + "/")) value = value.slice(origin.length);
  }
  const match = new RegExp(`^/w/(${ID})/p/(${ID})/?(?:\\?[^#]*)?(#.*)$`).exec(value);
  const threadId = match ? threadOfHash(match[3]) : undefined;
  return match && threadId ? { workspaceId: match[1], pageId: match[2], threadId } : null;
}

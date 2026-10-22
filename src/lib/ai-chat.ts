// Client-safe: shared by the AI chat's server side (src/server/ai-chat.ts, /api/ai/chat) and its
// panel (src/components/ai-chat).

import type { ChatChange, ChatConnectionRecord, ChatMemoryRecord, ChatStepRecord, ChatWriteAction, ChatWriteStepAction } from "@/db/schema/ai";
import type { PageKind } from "@/db/schema/app";
import type { BlockChange } from "./page-diff";
import type { AiErrorCode } from "./ai";

/** Conversations kept per person and workspace; the oldest go first. */
export const MAX_CONVERSATIONS = 50;

/** Notes the chat may keep about a person in a workspace (its memory), and the longest one. */
export const MAX_MEMORIES = 30;
export const MAX_MEMORY_CHARS = 300;

/** A note of the chat's memory, as the Memory view lists it. */
/** A note about the person; `app`: the connected app that kept or last changed it, if one did. */
export type MemoryView = { id: string; text: string; app: string | null; createdAt: string; updatedAt: string };

/** What the chat answers from: the whole workspace, or a page and the pages under it. */
export type ChatScope = { pageId: string } | null;

export type { ChatChange, ChatConnectionRecord, ChatMemoryRecord, ChatWriteAction, ChatWriteStepAction };

/**
 * What the chat may change: `ask` asks the person before each change (the answer waits), `auto`
 * makes changes without asking, `read` only reads (the model isn't offered changes at all).
 */
export const CHAT_MODES = ["ask", "auto", "read"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** How long a change waits for the person's decision before it counts as declined. */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** A source an answer cites, as the reader may see it now. */
export type ChatSourceView = {
  n: number;
  /** Null when the reader can no longer open the page (it's left out, title included). */
  pageId: string | null;
  workspaceId: string | null;
  title: string | null;
  icon: string | null;
  /** Page or database (for its icon). */
  kind: PageKind | null;
  /** The block the cited passage starts at, when known. */
  blockId: string | null;
};

/** A page the chat read, as the reader may see it now (null: they can no longer open it). */
export type ChatPageView = { pageId: string; workspaceId: string; title: string; icon: string | null; kind: PageKind } | null;

/**
 * A step the chat took on the way to an answer (shown above it): a search (`query` null for the
 * search with the question itself) and how many pages it found, a page it read, a database it
 * queried (its filters and how many rows matched), a change (see ChatWriteView), a note it kept
 * about the person or dropped (ChatMemoryRecord), a call to a connection's tool
 * (ChatConnectionRecord), or what the model said before searching or reading.
 */
export type ChatStepView =
  | { kind: "search"; query: string | null; results: number }
  | { kind: "read"; page: ChatPageView }
  | { kind: "query"; database: ChatPageView; conditions: ChatQueryCondition[]; any?: boolean; results: number }
  | ChatWriteView
  | ChatMemoryRecord
  | ChatConnectionRecord
  | { kind: "thought"; text: string };

/**
 * A change the chat made, the person declined or that failed: `target` is the database a row went
 * to, the row changed or the page a new page went under (null at the top of the workspace, or when
 * the reader can't open it any more: then title and changes are left out too); `page` the row or
 * page made or changed.
 */
export type ChatWriteView = {
  kind: "write";
  action: ChatWriteStepAction;
  outcome: "done" | "declined" | "failed";
  target: ChatPageView;
  page: ChatPageView;
  title: string | null;
  changes: ChatChange[];
};

/**
 * A change the chat asks to make (mode `ask`): what (`action`), where (`target` as in
 * ChatWriteView), the title of the row or page, the values it sets and the start of the text it
 * writes, if any. A call to a connection's tool that changes something (asked in every mode):
 * the connection, the tool as title and what it sends as content.
 */
export type ChatActionView = {
  /** A change to the workspace, a note about the person to keep or drop (title: its text), or a call to a connection's tool. */
  action: ChatWriteAction | "remember" | "forget" | "connection";
  /** A call to a connection's tool: the connection. */
  connection?: { name: string; icon: string | null };
  target: ChatPageView;
  title: string | null;
  /** A row renamed: its title now. */
  previousTitle?: string;
  changes: ChatChange[];
  content: string | null;
  /** A page's text changed: the blocks it changes, with one unchanged block around each. */
  diff?: BlockChange[];
};

/**
 * A filter rule of a database query (`op` as the tool takes it: equals, contains, is_within…); a
 * query step's rules are flattened from its groups, `any` when its top-level rules combine with or.
 */
export type ChatQueryCondition = { property: string; op: string; value: string | null };

export type ChatMessageView = {
  role: "user" | "assistant";
  content: string;
  /** Questions: the skill the answer followed. */
  skill?: { id: string; title: string };
  sources?: ChatSourceView[];
  note?: "stopped" | "cutOff";
  /** Answers: the steps taken and how long the answer took (not kept before steps were). */
  steps?: ChatStepView[];
  ms?: number;
  /** When it was asked or answered (ISO); missing while it's being written. */
  at?: string;
};

export type ConversationSummary = { id: string; title: string; updatedAt: string };

/** Whether an answer's step kept or dropped a note about the person (declined ones didn't). */
export const changedMemory = (step: ChatStepView) => step.kind === "memory" && step.outcome !== "declined";

/**
 * Whether an answer's step changed something: a change made in the workspace, or a call sent to a
 * connection's tool that changes something there (one that failed may have been done too).
 * Asking such an answer again would do it twice.
 */
export const changedThings = (step: ChatStepView | ChatStepRecord) =>
  (step.kind === "write" && step.outcome === "done") || (step.kind === "connection" && step.writes && step.outcome !== "declined");

/**
 * Lines of `POST /api/ai/chat`'s newline-delimited JSON answer, in order: `conversation` (its id,
 * first), `step` for each step taken (the model's searches, reads, queries and changes, and what it
 * said before them), `thinking` while the model works on a turn, `reasoning` with its thinking as
 * it comes (where the model shows it; not kept), `text` as the answer streams
 * (`reset` drops what was streamed before a tool call: it comes again as a `thought` step),
 * `sources` once the answer is complete, then `done` (with how long it took) or `error`.
 * `approval` asks the person about a change (mode `ask`): the answer waits for decideChange with
 * its id, sending `ping` now and then meanwhile.
 */
export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "thinking" }
  | { type: "reasoning"; text: string }
  | { type: "step"; step: ChatStepView }
  | { type: "approval"; id: string; action: ChatActionView }
  | { type: "ping" }
  | { type: "text"; text: string }
  | { type: "reset" }
  | { type: "sources"; sources: ChatSourceView[] }
  | { type: "done"; stopReason: "stop" | "length"; ms: number }
  | { type: "error"; code: AiErrorCode };

/** Source numbers an answer cites (`[1]`, `[2][3]`, `[1, 4]`), each once, in order. */
export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const n of match[1].split(",")) seen.add(Number(n.trim()));
  }
  return [...seen];
}

/** An answer's text with its citations taken out (earlier answers sent back to the model). */
export function stripCitations(text: string): string {
  return text.replace(/\s?\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, "");
}

/** What the model wrote before a tool call, as its `thought` step shows it: one line, no citations. */
export function thoughtText(text: string): string {
  return stripCitations(text).replace(/\s+/g, " ").trim();
}

/** Where the links citations become point (`[1](#cite-1)`), for the answer's renderer. */
export const CITE_HREF = "#cite-";

/**
 * An answer's markdown with each citation as a link to `#cite-<n>` (`[2, 3]` becomes two), which
 * the chat panel shows as a button to the source. Code, fenced (also still open while the answer
 * streams) or inline, stays as written, as do a real link's text and reference definitions.
 */
export function citationLinks(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?![(:])/g, (_, list: string) =>
            list
              .split(",")
              .map((n) => `[${n.trim()}](${CITE_HREF}${n.trim()})`)
              .join(""),
          ),
    )
    .join("");
}

/** The full-page chat, showing a conversation when given. */
export function chatPath(workspaceId: string, conversationId?: string | null): string {
  return `/w/${workspaceId}/ai${conversationId ? `?c=${encodeURIComponent(conversationId)}` : ""}`;
}

/** Whether a pathname is the workspace's full-page chat. */
export function isChatPath(pathname: string, workspaceId: string): boolean {
  return pathname === `/w/${workspaceId}/ai`;
}

/** The link to a cited passage: the page, scrolled to the block it starts at. */
export function sourceHref(source: Pick<ChatSourceView, "workspaceId" | "pageId" | "blockId">): string | null {
  if (!source.pageId || !source.workspaceId) return null;
  return `/w/${source.workspaceId}/p/${source.pageId}${source.blockId ? `#block-${source.blockId}` : ""}`;
}

/** A conversation's title: the start of its first question. */
export function conversationTitle(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

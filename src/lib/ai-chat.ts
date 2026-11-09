// Client-safe: shared by the AI chat's server side (src/server/ai-chat.ts, /api/ai/chat) and its
// panel (src/components/ai-chat).

import type { ChatAttachmentRecord, ChatChange, ChatConnectionRecord, ChatMailRecord, ChatMemoryRecord, ChatReminderRecord, ChatStepRecord, ChatToolRecord, ChatWebRecord, ChatWriteAction, ChatWriteStepAction } from "@/db/schema/ai";
import type { PageKind } from "@/db/schema/app";
import type { BlockChange } from "./page-diff";
import type { AiErrorCode } from "./ai";
import type { ChatAttachmentView } from "./chat-attachments";

/** Conversations kept per person and workspace; the oldest go first. */
export const MAX_CONVERSATIONS = 50;

/** Notes the chat may keep about a person in a workspace (its memory), and the longest one. */
export const MAX_MEMORIES = 500;
export const MAX_MEMORY_CHARS = 300;
/**
 * The longest details a note may carry under its line: what the note says in full (why, when, how),
 * read with read_memory when a question needs it, never sent with every question.
 */
export const MAX_MEMORY_DETAILS_CHARS = 2000;

/** The longest summary of a person's notes (server/memory-summary.ts), which goes with every question. */
export const MAX_MEMORY_SUMMARY_CHARS = 1500;

/**
 * A person's summary as the Memory page shows it: `stale` when they kept notes since it was written,
 * `withheld` when a note it was written from changed or was forgotten since, which keeps it from
 * being sent.
 */
export type MemorySummaryView = { text: string; writtenBy: "ai" | "person"; updatedAt: string; stale: boolean; withheld: boolean };

/**
 * What a note is about, so the Memory page can group and filter notes and the model sees what it
 * reads: who someone is (`profile`), how they like to work (`preference`), projects, decisions and
 * where things live (`work`), anything else (`other`, the default). No kind for other people: a
 * person's notes are about them alone.
 */
export const MEMORY_CATEGORIES = ["profile", "preference", "work", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const isMemoryCategory = (value: unknown): value is MemoryCategory => (MEMORY_CATEGORIES as readonly unknown[]).includes(value);

/** A note of the chat's memory, as the Memory view lists it; `app`: the connected app that kept or last changed it, if one did. */
export type MemoryView = { id: string; text: string; details: string | null; category: MemoryCategory; app: string | null; createdAt: string; updatedAt: string };

/**
 * Where a note the chat keeps or drops goes, beside the person's own notes in the workspace: their
 * notes for every workspace (`account`), the workspace's (`workspace`) or a teamspace's.
 */
export type MemoryLayer = "account" | "workspace" | "teamspace";

/** A note of the workspace or a teamspace (server/shared-memory.ts): `by`, who changed it last. */
export type SharedNoteView = MemoryView & { by: string | null };

/** The workspace's notes (`id` null) or a teamspace's, as the Memory page shows them. */
export type MemoryPlaceView = { id: string | null; name: string | null; icon: string | null; notes: SharedNoteView[]; canChange: boolean };

/** What the chat answers from: the whole workspace, a page and the pages under it, or a teamspace's pages. */
export type ChatScope = { pageId: string } | { teamspaceId: string } | null;

/**
 * The scope a question was asked in, as its conversation shows it: the page's or teamspace's
 * title as the person may see it now (null when they no longer can).
 */
export type ChatScopeView = { kind: "page" | "teamspace"; id: string; title: string | null };

export type { ChatAttachmentRecord, ChatAttachmentView, ChatChange, ChatConnectionRecord, ChatMemoryRecord, ChatToolRecord, ChatWebRecord, ChatWriteAction, ChatWriteStepAction };

// ----------------------------------------------------------------------------------- models

/**
 * What the chat box offers in a workspace: the models to pick from (the main one first; no picker
 * with one), the model a new conversation starts with (the person's latest), whether the chat may
 * search the web (owners turned it on, and the server has a search service), and whether research
 * mode can search the web too.
 */
export type ChatOptions = {
  /** `thinks`: the model thinks before it answers, so how much it does can be picked. */
  models: { id: string; name: string; images: boolean; thinks: boolean }[];
  defaultModel: string | null;
  /** How much a new conversation thinks: the person's latest conversation's choice. */
  defaultThinking: ChatThinking;
  webSearch: boolean;
  /** The workspace lets the chat change things without asking (mode `auto`, "don't ask again"). */
  autoChanges: boolean;
};

/**
 * How much the chat's model thinks before answering, the person's pick per conversation: `fast`
 * as little as the model allows (no thinking where it can stop), `balanced` the chat's own amount,
 * `deep` all the model's own (as research). Models that don't think ignore it.
 */
export const CHAT_THINKING = ["fast", "balanced", "deep"] as const;
export type ChatThinking = (typeof CHAT_THINKING)[number];
export const isChatThinking = (value: unknown): value is ChatThinking => typeof value === "string" && (CHAT_THINKING as readonly string[]).includes(value);

/**
 * What the chat may change: `ask` asks the person before each change (the answer waits), `auto`
 * makes changes without asking, `read` only reads (the model isn't offered changes at all).
 */
export const CHAT_MODES = ["ask", "auto", "read"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

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
  /** A web page the answer read: its address (`title` its title; `pageId` null). */
  url?: string;
  /** The page is verified now (server/verification.ts). */
  verified?: boolean;
};

/** A page the chat read, as the reader may see it now (null: they can no longer open it). */
export type ChatPageView = { pageId: string; workspaceId: string; title: string; icon: string | null; kind: PageKind } | null;

/**
 * A step the chat took on the way to an answer (shown above it): a search (`query` null for the
 * search with the question itself) and how many pages it found, a page it read, a database it
 * queried (its filters and how many rows matched), a change (see ChatWriteView), a note it kept
 * about the person or dropped (ChatMemoryRecord), a call to a connection's tool
 * (ChatConnectionRecord) or to one of Leafdesk's further tools (ChatToolRecord), or what the model
 * said before searching or reading.
 */
export type ChatStepView =
  | { kind: "search"; query: string | null; results: number }
  | { kind: "read"; page: ChatPageView }
  | { kind: "query"; database: ChatPageView; conditions: ChatQueryCondition[]; any?: boolean; results: number }
  | ChatWriteView
  | ChatMemoryRecord
  | ChatConnectionRecord
  | ChatToolRecord
  | ChatReminderRecord
  | { kind: "thought"; text: string }
  | { kind: "plan"; questions: string[] }
  | ChatWebRecord
  | ChatMailRecord;

/**
 * A change the chat made, the person declined or that failed: `target` is the database a row went
 * to, the row changed or the page a new page went under (null at the top of the workspace, or when
 * the reader can't open it any more: then title and changes are left out too); `page` the row or
 * page made or changed.
 */
export type ChatWriteView = {
  kind: "write";
  action: ChatWriteStepAction;
  outcome: "done" | "declined" | "failed" | "proposed";
  target: ChatPageView;
  page: ChatPageView;
  title: string | null;
  changes: ChatChange[];
};

/**
 * A change the chat asks to make (mode `ask`): what (`action`), where (`target` as in
 * ChatWriteView), the title of the row or page, the values it sets and the start of the text it
 * writes, if any. A call to a connection's tool that changes something (asked in every mode):
 * the connection, the tool as title and what it sends as content. A call to one of Leafdesk's
 * further tools that changes something (`tool`): its title, and what it is given as content. A web page to read or a web
 * search (asked in every mode, see lib/web-calls.ts): the address or the words as title. A mail
 * draft (`draftMail`, asked in every mode): its subject as title, its text as content and `mail`.
 */
export type ChatActionView = {
  /**
   * A change to the workspace, a note about the person to keep or drop (title: its text), a
   * reminder for them (title: its text, content: when, "YYYY-MM-DD HH:MM" on their clock) or one
   * of theirs cancelled or moved (the same, content its time then or its new one), a call
   * to a connection's tool, or a web call.
   */
  action: ChatWriteAction | "remember" | "forget" | "remind" | "cancelReminder" | "moveReminder" | "connection" | "tool" | "readWeb" | "searchWeb" | "draftMail";
  /** A reminder moved (`moveReminder`, content: its new time): the time it had, "YYYY-MM-DD HH:MM" on the person's clock. */
  reminderWas?: string;
  /** A call to a connection's tool: the connection. */
  connection?: { name: string; icon: string | null };
  /** A draft of the person's mail (server/ai-chat-mail.ts, asked in every mode): who it is from and to; `title` its subject, `content` its text. */
  mail?: { from: string; to: string[]; cc: string[] };
  /**
   * Asked about every time: "don't ask again" isn't offered, and the card and the Telegram bot
   * read only this. server/assistant/chat-dispatch.ts sets it on every ask the choice never
   * covers (a connection's call, a reminder, a web call, a note, a mail draft, a further tool that
   * reaches people or runs on its own: server/ai-more-tools.ts ASKED_EACH_TIME) and, with
   * `eachTimeReason`, on one asked about while "don't ask again" wouldn't hold.
   */
  eachTime?: boolean;
  /**
   * Why "don't ask again" wouldn't make the rest of the answer `auto`, said on the card: files are
   * attached to the conversation (`files`), or the answer read words no one in it wrote, from the
   * web, a connected service, email or another agent (`outside`). Without `eachTime` the choice is
   * still offered, covering only changes like this one (the same kind in the same database or page).
   */
  eachTimeReason?: "files" | "outside";
  /** A note kept or dropped elsewhere than the person's own notes in the workspace: where (`place`, a teamspace's name). */
  memoryLayer?: { layer: MemoryLayer; place: string | null };
  target: ChatPageView;
  title: string | null;
  /** A row renamed: its title now. */
  previousTitle?: string;
  changes: ChatChange[];
  content: string | null;
  /** A page's text changed: the blocks it changes, with one unchanged block around each. */
  diff?: BlockChange[];
  /** A PDF or Word document: the letterhead it is set in, when it has one. */
  letterhead?: string;
  /** An Excel workbook: the database (and view) its rows come from. */
  source?: string;
  /**
   * A database added: its properties, by name, with their type and options (`changes` says the
   * same in words, for the Telegram bot). A form added: who its public link takes answers from,
   * when it gets one.
   */
  properties?: { name: string; type: string; options?: string[] }[];
  /** A database made of a CSV file attached to the conversation: the file, and the rows it adds. */
  fromFile?: { name: string; rows: number };
  publicForm?: "signedIn" | "anonymous";
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
  /** Questions asked of part of the workspace: which part. */
  scope?: ChatScopeView;
  /** Questions: the files attached to it (gone ones left out). */
  attachments?: ChatAttachmentView[];
  /** A research question, or its report. */
  research?: boolean;
  /** Answers: the model that wrote it. */
  model?: string;
  sources?: ChatSourceView[];
  note?: "stopped" | "cutOff";
  /** Answers: the steps taken and how long the answer took (not kept before steps were). */
  steps?: ChatStepView[];
  ms?: number;
  /** When it was asked or answered (ISO); missing while it's being written. */
  at?: string;
};

/**
 * `answering`: an answer is on its way in it (maybe asked in another tab, or before a reload);
 * `waiting`: its answer waits for the person's decision on a change; `unread`: an answer was saved
 * after they last had it in front of them (lib/chat-status.ts says which one the list shows).
 */
export type ConversationSummary = { id: string; title: string; updatedAt: string; answering?: true; waiting?: true; unread?: true };

/** A change that makes a file (of a page, or of a database's rows) and attaches it to a page. */
export const makesFile = (action: string) => action === "createPdf" || action === "createDocx" || action === "createXlsx";

/** Whether an answer's step kept or dropped a note about the person (declined and undone ones didn't). */
export const changedMemory = (step: ChatStepView) => step.kind === "memory" && step.outcome !== "declined" && step.outcome !== "undone";

/**
 * Whether an answer's step changed something: a change made in the workspace, a reminder set, cancelled or moved, or a
 * call sent to a connection's tool that changes something there (one that failed may have been done too).
 * Asking such an answer again would do it twice.
 */
export const changedThings = (step: ChatStepView | ChatStepRecord) =>
  (step.kind === "write" && step.outcome === "done") ||
  (step.kind === "reminder" && step.action !== "list" && step.outcome === "done") ||
  ((step.kind === "connection" || step.kind === "leafdesk") && step.writes && step.outcome !== "declined");

/**
 * Lines of `POST /api/ai/chat`'s newline-delimited JSON answer, in order: `conversation` (its id,
 * first, with the question as the conversation will show it, when the answer started and whether it
 * replaces the last question and answer: what a page following the answer again shows), `step` for each step taken (the model's searches, reads, queries and changes, and what it
 * said before them), `thinking` while the model works on a turn, `reasoning` with its thinking as
 * it comes (where the model shows it; not kept), `text` as the answer streams
 * (`reset` drops what was streamed before a tool call: it comes again as a `thought` step),
 * `sources` once the answer is complete, then `done` (with how long it took) or `error`.
 * `approval` asks the person about a change (mode `ask`): the answer waits for decideChange with
 * its id, sending `ping` now and then meanwhile.
 */
export type ChatEvent =
  | { type: "conversation"; id: string; title: string; scope?: ChatScopeView; question?: ChatMessageView; startedAt?: number; replaceLast?: boolean }
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

/**
 * A research report as a page's Markdown (Save as page): each citation a link to its source, and
 * the sources listed under `heading` at the end. A source the reader can't open any more keeps its
 * number without a link or title. Code stays as written, as in citationLinks.
 */
export function reportMarkdown(text: string, sources: ChatSourceView[], heading: string): string {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const cited = citedNumbers(text).filter((n) => byNumber.has(n));
  const body = text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?![(:])/g, (whole, list: string) =>
            list
              .split(",")
              .map((n) => {
                const source = byNumber.get(Number(n.trim()));
                const href = source ? sourceHref(source) : null;
                return href ? `[[${n.trim()}]](${href})` : `[${n.trim()}]`;
              })
              .join(""),
          ),
    )
    .join("")
    .trim();
  if (!cited.length) return body;
  const list = cited.map((n) => {
    const source = byNumber.get(n)!;
    const href = sourceHref(source);
    const title = (source.title ?? "").replace(/[[\]]/g, "").trim() || href || "";
    return href ? `${n}. [${title}](${href})` : `${n}. ${title || "—"}`;
  });
  return `${body}\n\n## ${heading}\n\n${list.join("\n")}`;
}

/** The full-page chat, showing a conversation when given. */
export function chatPath(workspaceId: string, conversationId?: string | null): string {
  return `/w/${workspaceId}/ai${conversationId ? `?c=${encodeURIComponent(conversationId)}` : ""}`;
}

/** The Memory page: what the AI keeps for the person and the places they are in (`?section=`). */
export function memoryPagePath(workspaceId: string, section?: string): string {
  return `/w/${workspaceId}/memory${section ? `?section=${encodeURIComponent(section)}` : ""}`;
}

/** Whether a pathname is the workspace's full-page chat. */
export function isChatPath(pathname: string, workspaceId: string): boolean {
  return pathname === `/w/${workspaceId}/ai`;
}

/** The link to a cited passage: the page, scrolled to the block it starts at; a web page's address. */
export function sourceHref(source: Pick<ChatSourceView, "workspaceId" | "pageId" | "blockId" | "url">): string | null {
  if (source.url) return /^https?:\/\//i.test(source.url) ? source.url : null;
  if (!source.pageId || !source.workspaceId) return null;
  return `/w/${source.workspaceId}/p/${source.pageId}${source.blockId ? `#block-${source.blockId}` : ""}`;
}

/** A conversation's title: the start of its first question. */
export function conversationTitle(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

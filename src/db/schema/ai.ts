import { sql } from "drizzle-orm";
import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, type AnyPgColumn } from "drizzle-orm/pg-core";
import { databaseProperty, page, tsvector, workspace } from "./app";
import { agentRun } from "./agents";
import { user } from "./auth";
import { file } from "./files";
import type { ChatThinking } from "../../lib/ai-chat";

/**
 * Where an AI autofill value of a row stands (see server/ai-properties.ts): waiting or being worked
 * out ("pending"), failed ("error", with an AiErrorCode) or done. The value itself is an ordinary
 * text value in `page.properties`. `sourceHash` fingerprints what the last value was worked out from,
 * so automatic updates only run when the row's inputs really changed.
 */
export type AiPropertyStatus = "pending" | "error" | "done";

export const aiPropertyState = pgTable(
  "ai_property_state",
  {
    rowId: text("row_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    propertyId: text("property_id")
      .notNull()
      .references(() => databaseProperty.id, { onDelete: "cascade" }),
    status: text("status").$type<AiPropertyStatus>().notNull(),
    /** An AiErrorCode while `status` is "error". */
    error: text("error"),
    sourceHash: text("source_hash"),
    /** Who asked for the value last; the job runs with their access. */
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rowId, t.propertyId] }), index("ai_property_state_property_idx").on(t.propertyId)],
);

/**
 * Semantic search (#43): a page's text in chunks, each with its embedding (see
 * server/semantic-index.ts). Vectors are plain `real[]` so any PostgreSQL works without the
 * pgvector extension; `embedding_cosine` (drizzle/*_semantic_search.sql) ranks them. One row per
 * distinct chunk text of a page (`contentHash`), so chunks that didn't change keep their vector.
 * Chunks of another model than the configured one are ignored and replaced when the page is
 * indexed again.
 */
export const pageChunk = pgTable(
  "page_chunk",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** sha256 of the chunk's text as embedded. */
    contentHash: text("content_hash").notNull(),
    /** Order within the page. */
    position: integer("position").notNull(),
    /** The block the chunk starts at, for links to the passage; null for title and properties. */
    blockId: text("block_id"),
    text: text("text").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: real("embedding").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.contentHash] }), index("page_chunk_workspace_model_idx").on(t.workspaceId, t.model)],
);

/**
 * When a page was last indexed for semantic search, and from what: `sourceHash` fingerprints its
 * chunks and the model, `chunkerVersion` is the CHUNKER_VERSION of the chunking (semantic-text.ts),
 * `sourceUpdatedAt` is the page's `updated_at` then. Pages changed since (or never indexed, or
 * indexed with another model or chunking) are picked up by the background sweep.
 */
export const pageIndexState = pgTable(
  "page_index_state",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => page.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    sourceHash: text("source_hash").notNull(),
    chunkerVersion: integer("chunker_version").notNull().default(0),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_index_state_workspace_idx").on(t.workspaceId)],
);

/**
 * The text of an uploaded PDF, Word document or Excel workbook, as search finds it (see server/file-text.ts): read
 * once per file and kept, since a stored file's bytes never change.
 * `contentHash` is the sha256 of the bytes, so the same document uploaded again elsewhere isn't read
 * again either. `text` is empty when the file has none to give (a scan, a damaged or locked file);
 * `partial` says only its start was read (the page and length limits). Rows of an older
 * `extractorVersion` are read again.
 */
export const fileText = pgTable(
  "file_text",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => file.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    extractorVersion: integer("extractor_version").notNull(),
    text: text("text").notNull(),
    /** Pages of a PDF (all of them, not only those read); null for other files. */
    pages: integer("pages"),
    partial: boolean("partial").notNull().default(false),
    /** The file couldn't be read at all (as opposed to having no text). */
    failed: boolean("failed").notNull().default(false),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * What full-text search matches in the document (server/pages.ts fullTextSearch): its words,
     * folded as a page's are (search_fold, migration 0093), and the two-character pieces of its
     * Chinese and Japanese text, from its first 80,000 characters as for a page's body, so that the
     * vector stays under Postgres' tsvector limit (migration 0077). Large: select it only where a
     * query needs it.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', search_fold(left(text, 80000))) || to_tsvector('simple', cjk_bigrams(left(text, 80000)))`,
    ),
  },
  (t) => [index("file_text_content_hash_idx").on(t.contentHash), index("file_text_search_vector_idx").using("gin", t.searchVector)],
);

/**
 * A source an answer of the AI chat cites: a page (and the block the passage starts at), or a web
 * page it read (its address and title then).
 */
export type ChatSourceRef =
  | { n: number; pageId: string; blockId: string | null; url?: undefined }
  | { n: number; url: string; title: string; pageId?: undefined; blockId?: undefined };

/**
 * A step the AI chat took on the way to an answer: a search (`query` null for the one with the
 * question itself) and how many pages it found, a page it read, a database it queried (with the
 * filters and how many rows matched), a change it made or was refused (see ChatWriteRecord), a
 * note it kept or dropped about the person (ChatMemoryRecord), a call to a connection's tool
 * (ChatConnectionRecord), what the model said before searching or reading, the sub-questions a
 * research answer set out to answer (`plan`), and a web search or web page read (ChatWebRecord).
 */
export type ChatStepRecord =
  | { kind: "search"; query: string | null; results: number }
  | { kind: "read"; pageId: string }
  | { kind: "plan"; questions: string[] }
  | ChatWebRecord
  | { kind: "query"; databaseId: string; conditions: ChatQueryCondition[]; any?: boolean; results: number }
  | ChatWriteRecord
  | ChatMemoryRecord
  | ChatConnectionRecord
  | ChatToolRecord
  | { kind: "thought"; text: string };

/**
 * The AI chat on the web (where owners turned it on, server/agents/web.ts): a search (`query`, how
 * many results), or a page read (`url`, its title; `failed` when it couldn't be read, `url` as asked).
 */
export type ChatWebRecord =
  | { kind: "web"; action: "search"; query: string; results: number }
  | { kind: "web"; action: "read"; url: string; title: string; outcome: "done" | "failed" };

/**
 * A call the AI chat made to a connection's tool (server/connections), with the connection's name
 * then: `done`, `failed`, or `declined` by the person (a tool that changes something is asked
 * about each time). `writes`: the tool changes something at the service; `input`: what was sent
 * (or would have been), credentials masked, cut to fit.
 */
export type ChatConnectionRecord = {
  kind: "connection";
  connectionId: string;
  connection: string;
  tool: string;
  writes: boolean;
  input: string;
  outcome: "done" | "failed" | "declined";
};

/**
 * A call to one of Leafdesk's further tools (server/ai-more-tools.ts): its name and title, whether
 * it changes something, what the model gave it (cut to fit) and how it went (`declined`: the person
 * said no, nothing was done).
 */
export type ChatToolRecord = {
  kind: "leafdesk";
  tool: string;
  title: string;
  writes: boolean;
  input: string;
  outcome: "done" | "failed" | "declined";
};

/**
 * A note the chat kept about the person (`remember`, also in place of an older note) or dropped
 * (`forget`), with its text then, or that the person declined to have kept or dropped; see
 * server/ai-memory.ts. Records from before notes were approved have no outcome: they were done.
 * An agent's run `propose`s notes instead: they wait for an owner (server/agents/memory.ts).
 */
/** `handoff`: a schedule's run left a note for the schedule's next run (server/agents/memory.ts). */
export type ChatMemoryRecord = { kind: "memory"; action: "remember" | "propose" | "forget" | "handoff"; text: string; outcome?: "done" | "declined" };

/** A note in use (`kept`), or one an agent's run proposed that waits for an owner (`proposed`). */
export type MemoryStatus = "kept" | "proposed";

/**
 * A change the AI chat may make: add a database row, change one, add a page, change a page's text,
 * make a PDF file of a page and attach it to the page, comment on a page, add a database (empty
 * or from a CSV file attached to the conversation) or add a form view to a database.
 */
export type ChatWriteAction = "createRow" | "updateRow" | "createPage" | "editPage" | "createPdf" | "addComment" | "createDatabase" | "createForm";

/** A change made, as a step records it: one the chat may make, or duplicate rows an agent's run merged. */
export type ChatWriteStepAction = ChatWriteAction | "mergeRows";

/** A value a change sets, as shown to the person ("" clears it), and when asked, the value it had ("" none). */
export type ChatChange = { property: string; value: string; before?: string };

/**
 * A change the AI chat made (`done`), the person declined (`declined`) or that failed once
 * approved (`failed`). `targetId`: the database a row or form goes to, the row changed, the page a
 * new page or database goes under (null: the top of the workspace), the page a PDF is made of or
 * the page commented on; `pageId`: the row, page or database made or changed (a form's database).
 */
export type ChatWriteRecord = {
  kind: "write";
  action: ChatWriteStepAction;
  /** `proposed`: an agent's change kept for review (server/pending-changes.ts), not made yet. */
  outcome: "done" | "declined" | "failed" | "proposed";
  targetId: string | null;
  pageId: string | null;
  /** The new title (a row or page added, a row renamed). */
  title: string | null;
  changes: ChatChange[];
};

/** One filter rule of a database query the chat ran, as shown with the step. */
export type ChatQueryCondition = { property: string; op: string; value: string | null };

/**
 * A file attached to a question of the AI chat (ai_chat_file), with its name, type and size then:
 * its name is unique in the conversation, so the chat's tools can name it. A CSV file also keeps
 * how many rows and columns it has. The file stays with the conversation, so later questions see it
 * too.
 */
export type ChatAttachmentRecord = { id: string; name: string; contentType: string; size: number; rows?: number; columns?: number };

/** One message of an AI chat conversation, as stored. */
export type ChatMessageRecord = {
  role: "user" | "assistant";
  content: string;
  /** Questions: the skill the answer followed, with its title then. */
  skill?: { id: string; title: string };
  /** Questions asked of part of the workspace: a page (and the pages under it) or a teamspace. */
  scope?: { kind: "page" | "teamspace"; id: string };
  /** Questions: the files attached to it. */
  attachments?: ChatAttachmentRecord[];
  /** Questions asked in research mode, and their answers (a report). */
  research?: boolean;
  /** Answers: the model that wrote it. */
  model?: string;
  /** Assistant answers: the sources the answer cites as [n]. */
  sources?: ChatSourceRef[];
  /** Answers that didn't finish: stopped by the person, or cut off at the length limit. */
  note?: "stopped" | "cutOff";
  /** Assistant answers: the steps taken, and how long it took from question to answer. */
  steps?: ChatStepRecord[];
  ms?: number;
  at: string;
};

/**
 * AI chat conversations (#41), private to the person who had them: only they can list, read or
 * delete them, and workspace backups leave them out. Deleted with their account, when they leave
 * the workspace and with the workspace.
 * Cited pages are looked up again with the reader's current access whenever they are shown.
 */
export const aiConversation = pgTable(
  "ai_conversation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    /**
     * The model the person picked for it, one of those the workspace's AI offers the chat (see
     * server/ai chatModelsFor); null: the workspace's main model. A new conversation starts with the
     * model of the person's latest one.
     */
    model: text("model"),
    /** How much its model thinks (lib/ai-chat.ts ChatThinking); null: `balanced`. Kept like `model`. */
    thinking: text("thinking").$type<ChatThinking>(),
    messages: jsonb("messages").$type<ChatMessageRecord[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_conversation_user_idx").on(t.userId, t.workspaceId, t.updatedAt)],
);

/**
 * A file someone attached to a question of the AI chat (server/ai-chat-files.ts): an uploaded
 * `file` of the workspace that no page holds (`file.page_id` null), readable by the person who
 * attached it alone, never through a page (files.ts fileForViewer doesn't know it) or a backup.
 * `conversationId` is set once the question it went with is kept; until then (uploaded, not sent)
 * the upload cleanup removes it after a day. Deleting the conversation deletes its files; when the
 * conversation goes another way (the person leaves the workspace, deletes their account), this row
 * goes with it and the file is removed as an orphan.
 */
export const aiChatFile = pgTable(
  "ai_chat_file",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => file.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => aiConversation.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_chat_file_user_idx").on(t.userId, t.workspaceId), index("ai_chat_file_conversation_idx").on(t.conversationId)],
);

/**
 * What the AI chat remembers about a person in a workspace (see server/ai-memory.ts): short notes
 * on who they are, what they work on and how they want answers, kept by the chat when they tell it
 * or written by them in the chat's Memory view. Private to that person like their conversations
 * (workspace backups leave them out too), and deleted with their account, when they leave the
 * workspace and with the workspace.
 * `conversationId` is where the chat noted it (null: the person wrote it, or the conversation is gone).
 *
 * An agent's notes are kept here too, under its own user (server/agents/memory.ts): what its runs
 * proposed (`status` proposed, `agentRunId` the run) and what its owners kept or wrote (no run);
 * these are backed up with the agent. A proposal with `replacesId` is a new text for that kept
 * note: keeping it changes the note in place.
 * Only kept notes go with its runs. A proposal no owner answered goes with its run, when the run
 * is pruned; notes stay while the agent is archived and go with it.
 */
export const aiMemory = pgTable(
  "ai_memory",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    conversationId: text("conversation_id").references(() => aiConversation.id, { onDelete: "set null" }),
    status: text("status").$type<MemoryStatus>().notNull().default("kept"),
    agentRunId: text("agent_run_id").references(() => agentRun.id, { onDelete: "cascade" }),
    /** A proposal's kept note it would change (null: a new note, also once that note is gone). */
    replacesId: text("replaces_id").references((): AnyPgColumn => aiMemory.id, { onDelete: "set null" }),
    /** The connected app (OAuth client) that kept the note or last changed it over MCP, if one did. */
    oauthClientId: text("oauth_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_memory_user_idx").on(t.userId, t.workspaceId, t.createdAt)],
);

/**
 * What a workspace's AI requests used in a calendar month (UTC), by feature (AiRequest.feature, e.g.
 * "chat" or "editor.improve") and model, added to after every request (server/ai/usage.ts): the
 * workspace's AI bill, kept AI_USAGE_MONTHS. `ownAccount` tells apart what the workspace's own AI
 * account paid from what the server's AI_* key paid, which only the server's limit counts. Never
 * anything that was asked or answered.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The month's first day. */
    month: date("month").notNull(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    ownAccount: boolean("own_account").notNull(),
    requests: integer("requests").notNull().default(0),
    /** Input not read from or written to the provider's prompt cache. */
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    /** As the provider's prices give it; 0 for models without known prices. */
    costUsd: doublePrecision("cost_usd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.month, t.feature, t.model, t.ownAccount] })],
);

/**
 * The same month's AI requests by who asked and feature (server/ai/usage.ts), for the usage view's
 * breakdown by person: `userId` is the person (an agent's own user for its runs), null for work
 * nobody asked for (background indexing, autofill of new rows…). Counted from migration 0120 on:
 * months before it are only in `ai_usage`. Kept and pruned with it; never what was asked.
 */
export const aiUsagePerson = pgTable(
  "ai_usage_person",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The month's first day. */
    month: date("month").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
  },
  // Nobody's requests (a null user) add up in one row per feature too.
  (t) => [unique("ai_usage_person_key").on(t.workspaceId, t.month, t.userId, t.feature).nullsNotDistinct()],
);

/**
 * Prompts a person saved to reuse in the editor's AI assistant (lib/ai-saved-prompts), in one
 * workspace. Theirs alone: nobody else lists them, and team-wide instructions are skills.
 */
export const aiSavedPrompt = pgTable(
  "ai_saved_prompt",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_saved_prompt_user_idx").on(t.userId, t.workspaceId, t.createdAt)],
);

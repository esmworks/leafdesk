import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";
import { databaseProperty, page, tsvector, workspace } from "./app";
import { agentRun } from "./agents";
import { user } from "./auth";
import { file } from "./files";

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

/** A source an answer of the AI chat cites: a page (and the block the passage starts at). */
export type ChatSourceRef = { n: number; pageId: string; blockId: string | null };

/**
 * A step the AI chat took on the way to an answer: a search (`query` null for the one with the
 * question itself) and how many pages it found, a page it read, a database it queried (with the
 * filters and how many rows matched), a change it made or was refused (see ChatWriteRecord), a
 * note it kept or dropped about the person (ChatMemoryRecord), or what the model said before
 * searching or reading.
 */
export type ChatStepRecord =
  | { kind: "search"; query: string | null; results: number }
  | { kind: "read"; pageId: string }
  | { kind: "query"; databaseId: string; conditions: ChatQueryCondition[]; any?: boolean; results: number }
  | ChatWriteRecord
  | ChatMemoryRecord
  | { kind: "thought"; text: string };

/**
 * A note the chat kept about the person (`remember`, also in place of an older note) or dropped
 * (`forget`), with its text then, or that the person declined to have kept or dropped; see
 * server/ai-memory.ts. Records from before notes were approved have no outcome: they were done.
 * An agent's run `propose`s notes instead: they wait for an owner (server/agents/memory.ts).
 */
export type ChatMemoryRecord = { kind: "memory"; action: "remember" | "propose" | "forget"; text: string; outcome?: "done" | "declined" };

/** A note in use (`kept`), or one an agent's run proposed that waits for an owner (`proposed`). */
export type MemoryStatus = "kept" | "proposed";

/** A change the AI chat may make: add a database row, change one, add a page, or change a page's text. */
export type ChatWriteAction = "createRow" | "updateRow" | "createPage" | "editPage";

/** A value a change sets, as shown to the person ("" clears it), and when asked, the value it had ("" none). */
export type ChatChange = { property: string; value: string; before?: string };

/**
 * A change the AI chat made (`done`), the person declined (`declined`) or that failed once
 * approved (`failed`). `targetId`: the database a row goes to, the row changed, or the page a new
 * page goes under (null: the top of the workspace); `pageId`: the row or page made or changed.
 */
export type ChatWriteRecord = {
  kind: "write";
  action: ChatWriteAction;
  outcome: "done" | "declined" | "failed";
  targetId: string | null;
  pageId: string | null;
  /** The new title (a row or page added, a row renamed). */
  title: string | null;
  changes: ChatChange[];
};

/** One filter rule of a database query the chat ran, as shown with the step. */
export type ChatQueryCondition = { property: string; op: string; value: string | null };

/** One message of an AI chat conversation, as stored. */
export type ChatMessageRecord = {
  role: "user" | "assistant";
  content: string;
  /** Questions: the skill the answer followed, with its title then. */
  skill?: { id: string; title: string };
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
 * delete them. Deleted with their account, when they leave the workspace and with the workspace.
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
    messages: jsonb("messages").$type<ChatMessageRecord[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_conversation_user_idx").on(t.userId, t.workspaceId, t.updatedAt)],
);

/**
 * What the AI chat remembers about a person in a workspace (see server/ai-memory.ts): short notes
 * on who they are, what they work on and how they want answers, kept by the chat when they tell it
 * or written by them in the chat's Memory view. Private to that person like their conversations,
 * and deleted with their account, when they leave the workspace and with the workspace.
 * `conversationId` is where the chat noted it (null: the person wrote it, or the conversation is gone).
 *
 * An agent's notes are kept here too, under its own user (server/agents/memory.ts): what its runs
 * proposed (`status` proposed, `agentRunId` the run) and what its owners kept or wrote (no run).
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
    /** The connected app (OAuth client) that kept the note or last changed it over MCP, if one did. */
    oauthClientId: text("oauth_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_memory_user_idx").on(t.userId, t.workspaceId, t.createdAt)],
);

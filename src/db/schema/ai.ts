import { index, integer, jsonb, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";
import { databaseProperty, page, workspace } from "./app";
import { user } from "./auth";

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
 * chunks and the model, `sourceUpdatedAt` is the page's `updated_at` then. Pages changed since
 * (or never indexed, or indexed with another model) are picked up by the background sweep.
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
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_index_state_workspace_idx").on(t.workspaceId)],
);

/** A source an answer of the AI chat cites: a page (and the block the passage starts at). */
export type ChatSourceRef = { n: number; pageId: string; blockId: string | null };

/**
 * A step the AI chat took on the way to an answer: a search (`query` null for the one with the
 * question itself) and how many pages it found, a page it read, a database it queried (with the
 * filters and how many rows matched), a change it made or was refused (see ChatWriteRecord), or
 * what the model said before searching or reading.
 */
export type ChatStepRecord =
  | { kind: "search"; query: string | null; results: number }
  | { kind: "read"; pageId: string }
  | { kind: "query"; databaseId: string; conditions: ChatQueryCondition[]; any?: boolean; results: number }
  | ChatWriteRecord
  | { kind: "thought"; text: string };

/** A change the AI chat may make: add a database row, change one, or add a page. */
export type ChatWriteAction = "createRow" | "updateRow" | "createPage";

/** A value a change sets, as shown to the person ("" clears it). */
export type ChatChange = { property: string; value: string };

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

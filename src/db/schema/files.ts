import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { StorageConfig, StorageKind, StorageStatus } from "../../lib/workspace-storage";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * Storage a workspace brings itself for its uploads (see server/storage/workspace.ts), instead of
 * the instance's own (STORAGE_DRIVER / UPLOAD_DIR / S3_*). `config` holds what isn't secret (an S3
 * endpoint and bucket); `credentials` is sealed (server/secret-box) and never leaves the server.
 *
 * A workspace uploads to at most one target at a time: the one that isn't `disconnected`. A
 * disconnected target still reads and deletes the files stored on it, so it stays until no file and
 * no queued deletion names it; the hourly cleanup then removes it. So does a deleted workspace's
 * (`workspaceId` set null), once its files are gone from it.
 */
export const workspaceStorage = pgTable(
  "workspace_storage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    kind: text("kind").$type<StorageKind>().notNull(),
    config: jsonb("config").$type<StorageConfig>().notNull(),
    /** Sealed JSON: an S3 access key pair, or what signing in to Drive or Dropbox gave (OAuthCredentials). */
    credentials: text("credentials").notNull(),
    /** `broken` after the storage refused a request (revoked keys, a deleted bucket); `active` again after one succeeds. */
    status: text("status").$type<StorageStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** When a test object last went there and back (on connecting, or Test again). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("workspace_storage_current_idx").on(t.workspaceId).where(sql`${t.status} <> 'disconnected'`),
    check("workspace_storage_kind_check", sql`${t.kind} in ('s3', 'gdrive', 'dropbox')`),
    check("workspace_storage_status_check", sql`${t.status} in ('active', 'broken', 'disconnected')`),
  ],
);

/**
 * A sign-in to a storage provider an owner began (Settings > Storage > Google Drive or Dropbox),
 * until the browser comes back with its `state` (server/storage/settings.ts). Used once; ones older
 * than fifteen minutes are void. `data` is sealed: the PKCE verifier.
 */
export const workspaceStorageOauth = pgTable("workspace_storage_oauth", {
  state: text("state").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").$type<StorageKind>().notNull(),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An uploaded file (see server/files.ts). The bytes live in the storage driver under `storageKey`;
 * this row says which workspace they count against and which page they were uploaded to.
 *
 * `pageId` is cleared when that page is deleted for good. The file then lives on only while a page
 * still shows it (see fileReference); the cleanup removes it once none does.
 */
export const file = pgTable(
  "file",
  {
    /** Random and unguessable (see lib/files.ts); also the last part of its URL. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => page.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    /** The workspace's own storage the bytes are in; null for the instance's. */
    storageId: text("storage_id").references(() => workspaceStorage.id, { onDelete: "restrict" }),
    /** The storage's own id for the object, where it addresses objects by id rather than by key. */
    storageObjectId: text("storage_object_id"),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    /** When a page body first showed it; null for uploads nothing ever used (cleaned up after a day). */
    referencedAt: timestamp("referenced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_workspace_idx").on(t.workspaceId), index("file_page_idx").on(t.pageId), index("file_storage_idx").on(t.storageId)],
);

/**
 * Pages whose body shows a file: its URL appears in their derived Markdown. Kept by a trigger on
 * `page.content_markdown` (drizzle/0015_file_uploads.sql), so every way a body is written (the
 * editor, MCP, duplicates, templates, history restores) keeps it current. Only pages of the file's
 * own workspace count.
 *
 * The trigger records every URL a page shows, but a reference lets the page's viewers read the file
 * only once it is `authorized`: the write that put it there was made by someone who could read the
 * file already (see server/files.ts). Writing a file's URL into a page therefore never grants
 * anything by itself.
 */
export const fileReference = pgTable(
  "file_reference",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Whether the page's viewers may read the file through this reference (see above). */
    authorized: boolean("authorized").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.pageId] }), index("file_reference_page_idx").on(t.pageId)],
);

/**
 * Stored objects to delete (see server/files.ts, `removeStored`). Whatever removes a file's row adds
 * its key here in the same transaction, so the bytes can't outlive the row unnoticed: the cleanup
 * deletes the object and then this row, and an object storage refused stays here to be tried again
 * later, also after a restart. An object is its key in its storage: the instance's (`storageId`
 * null) or a workspace's own, which the entry keeps from being removed until it is done.
 */
export const storageDeletion = pgTable(
  "storage_deletion",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storageId: text("storage_id").references(() => workspaceStorage.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    storageObjectId: text("storage_object_id"),
    attempts: integer("attempts").notNull().default(0),
    /** Not before then: later after each failure. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("storage_deletion_next_attempt_idx").on(t.nextAttemptAt),
    unique("storage_deletion_object_key").on(t.storageId, t.storageKey).nullsNotDistinct(),
  ],
);

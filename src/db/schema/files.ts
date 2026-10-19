import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { AccountConfig, MoveReason, MoveStatus, PlaceConfig, StorageKind, StorageStatus } from "../../lib/workspace-storage";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * Storage someone connected to their Leafdesk account for workspaces' uploads (see
 * server/storage/accounts.ts), instead of the instance's own (STORAGE_DRIVER / UPLOAD_DIR / S3_*):
 * an S3-compatible bucket, a Google Drive or a Dropbox. Connected once, used by every workspace its
 * owner attaches it to, each in a place of its own there (`workspace_storage`). `config` holds what
 * isn't secret (an endpoint and bucket, the Drive account); `credentials` is sealed
 * (server/secret-box) and never leaves the server.
 *
 * `disconnected` once its owner disconnected it, and when their Leafdesk account is gone
 * (`userId` null): no workspace may start using it, but it keeps serving the files still stored on
 * it until they are moved or deleted; the hourly cleanup then removes it with its credentials.
 */
export const storageAccount = pgTable(
  "storage_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    kind: text("kind").$type<StorageKind>().notNull(),
    config: jsonb("config").$type<AccountConfig>().notNull(),
    /** Sealed JSON: an S3 access key pair, or what signing in to Drive or Dropbox gave (OAuthCredentials). */
    credentials: text("credentials").notNull(),
    /** What its owner calls it: the bucket or the account's address at first. */
    label: text("label").notNull(),
    /** New workspaces its owner makes use it from the start. At most one per person. */
    isDefault: boolean("is_default").notNull().default(false),
    /** `broken` after the storage refused a request (revoked keys, a deleted bucket); `active` again after one succeeds. */
    status: text("status").$type<StorageStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** When a test object last went there and back (on connecting, or Test again). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("storage_account_user_idx").on(t.userId),
    uniqueIndex("storage_account_default_idx").on(t.userId).where(sql`${t.isDefault} and ${t.status} <> 'disconnected'`),
    check("storage_account_kind_check", sql`${t.kind} in ('s3', 'gdrive', 'dropbox')`),
    check("storage_account_status_check", sql`${t.status} in ('active', 'broken', 'disconnected')`),
  ],
);

/**
 * A workspace's place in a storage account (see server/storage/workspace.ts): its Drive folder, or
 * (for a bucket or a Dropbox) just the account, the workspace's keys starting with its id. Files
 * and queued deletions point at this row (`storage_id`), so it is kept while they do.
 *
 * A workspace uploads to at most one place at a time: the one that isn't `disconnected`. A
 * disconnected place still reads and deletes the files stored there, so it stays until no file and
 * no queued deletion names it; the hourly cleanup then removes it. So does a deleted workspace's
 * (`workspaceId` set null), once its files are gone from it. How the storage is doing (working,
 * refusing) is its account's.
 */
export const workspaceStorage = pgTable(
  "workspace_storage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    storageAccountId: text("storage_account_id")
      .notNull()
      .references(() => storageAccount.id, { onDelete: "restrict" }),
    /** Its account's kind, kept here too. */
    kind: text("kind").$type<StorageKind>().notNull(),
    config: jsonb("config").$type<PlaceConfig>().notNull(),
    status: text("status").$type<"active" | "disconnected">().notNull().default("active"),
    /** Who attached it to the workspace. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("workspace_storage_current_idx").on(t.workspaceId).where(sql`${t.status} <> 'disconnected'`),
    index("workspace_storage_account_idx").on(t.storageAccountId),
    check("workspace_storage_kind_check", sql`${t.kind} in ('s3', 'gdrive', 'dropbox')`),
    check("workspace_storage_status_check", sql`${t.status} in ('active', 'disconnected')`),
  ],
);

/**
 * A sign-in to a storage provider someone began (connecting Google Drive or Dropbox to their
 * account), until the browser comes back with its `state` (server/storage/accounts.ts). Used once;
 * ones older than fifteen minutes are void. `workspaceId`: the workspace it was begun from, which
 * then starts using it. `data` is sealed: the PKCE verifier.
 */
export const storageOauth = pgTable("storage_oauth", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").$type<StorageKind>().notNull(),
  workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
  data: text("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Moving a workspace's files from where they are to another storage (see server/storage/moves.ts):
 * to a storage account (`toAccountId`, then its place `toStorageId` once made) or to the instance's
 * storage (`toServer`). The files go a few at a time, each row pointed at its copy as soon as it is
 * there, so the workspace keeps working throughout; the old copies are deleted only once every file
 * is across (their queued deletions wait for it, `storage_deletion.move_id`). It picks up where it
 * was after a restart. `fromStorageIds`: the places whose files go; null for every file not at the
 * destination yet.
 */
export const storageMove = pgTable(
  "storage_move",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    fromStorageIds: text("from_storage_ids").array(),
    toServer: boolean("to_server").notNull().default(false),
    toAccountId: text("to_account_id").references(() => storageAccount.id, { onDelete: "set null" }),
    toStorageId: text("to_storage_id").references(() => workspaceStorage.id, { onDelete: "set null" }),
    status: text("status").$type<MoveStatus>().notNull().default("queued"),
    reason: text("reason").$type<MoveReason>().notNull(),
    /** Whose storage it moves away from, when that person went (left, removed, deleted their account). */
    leaverId: text("leaver_id").references(() => user.id, { onDelete: "set null" }),
    files: integer("files").notNull().default(0),
    moved: integer("moved").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    lastError: text("last_error"),
    /** A worker has it until then (renewed as it goes), so two servers don't move the same files. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /**
     * Which worker holds the move: set anew whenever one takes it, so a worker whose lease ran out
     * and was taken over notices (its writes name its lease) and stops.
     */
    leaseId: text("lease_id"),
    startedBy: text("started_by").references(() => user.id, { onDelete: "set null" }),
    /** Owners closed the notice of a finished, failed or blocked move. */
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("storage_move_workspace_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("storage_move_open_idx").on(t.workspaceId).where(sql`${t.status} in ('queued', 'running')`),
    check("storage_move_status_check", sql`${t.status} in ('queued', 'running', 'done', 'failed', 'blocked')`),
    check("storage_move_reason_check", sql`${t.reason} in ('manual', 'left', 'removed', 'accountDeleted', 'disconnected')`),
  ],
);

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
  (t) => [index("file_workspace_idx").on(t.workspaceId), index("file_page_idx").on(t.pageId), index("file_storage_idx").on(t.storageId), index("file_storage_key_idx").on(t.storageKey)],
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
    /** The move this old copy was left behind by: not deleted until that move has every file across. */
    moveId: text("move_id").references(() => storageMove.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    /** Not before then: later after each failure. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("storage_deletion_next_attempt_idx").on(t.nextAttemptAt),
    index("storage_deletion_move_idx").on(t.moveId),
    unique("storage_deletion_object_key").on(t.storageId, t.storageKey).nullsNotDistinct(),
  ],
);

import { bigint, boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { page, workspace } from "./app";
import { user } from "./auth";

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
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    /** When a page body first showed it; null for uploads nothing ever used (cleaned up after a day). */
    referencedAt: timestamp("referenced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_workspace_idx").on(t.workspaceId), index("file_page_idx").on(t.pageId)],
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

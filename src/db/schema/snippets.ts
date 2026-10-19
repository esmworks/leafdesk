import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * A snippet (server/snippets.ts): a reusable piece of content people insert into a page while
 * typing, by its trigger after `;` or from the slash menu. It belongs to one person (`userId`,
 * only they see it) or to a workspace (`workspaceId`, for its owners and members), never both.
 * `body` is Leafdesk Markdown (lib/content-markdown.ts) with placeholders such as `{{date}}` that
 * the editor fills in when it is inserted (lib/snippets.ts).
 */
export const snippet = pgTable(
  "snippet",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    /** Short and unique within its scope: lowercase letters, digits, `-` and `_`. */
    trigger: text("trigger").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("snippet_user_trigger_idx").on(t.userId, t.trigger).where(sql`${t.userId} is not null`),
    uniqueIndex("snippet_workspace_trigger_idx").on(t.workspaceId, t.trigger).where(sql`${t.workspaceId} is not null`),
    index("snippet_created_by_idx").on(t.createdBy),
    check("snippet_scope_check", sql`(${t.userId} is null) <> (${t.workspaceId} is null)`),
    check("snippet_trigger_check", sql`${t.trigger} ~ '^[a-z0-9_-]{1,32}$'`),
  ],
);

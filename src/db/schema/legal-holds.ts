import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { workspace } from "./app";
import { user } from "./auth";

/**
 * A legal hold (server/legal-hold.ts): owners put one on people of the workspace, members, guests
 * or people who have left, and while it stands nothing those people created or edited there can be
 * deleted for good. Releasing it deletes the row; the audit log keeps both. The workspace can't be
 * deleted while it has one (`restrict`), whatever path tries.
 */
export const legalHold = pgTable(
  "legal_hold",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Why it was set, for the owners who come after; empty for none. */
    reason: text("reason").notNull().default(""),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_hold_workspace_idx").on(t.workspaceId)],
);

/** The people a legal hold covers. Their accounts can't be deleted while it stands (`restrict`). */
export const legalHoldPerson = pgTable(
  "legal_hold_person",
  {
    holdId: text("hold_id")
      .notNull()
      .references(() => legalHold.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.holdId, t.userId] }), index("legal_hold_person_user_idx").on(t.userId)],
);

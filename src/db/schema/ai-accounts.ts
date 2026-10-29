import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AiAccountStatus, OwnAiProvider } from "../../lib/ai-accounts";
import { user } from "./auth";

/**
 * A person's own AI provider account (OWN_AI_KEYS_ENABLED, see server/ai-accounts.ts): a key they
 * added once, which workspaces they own can run all their AI on (`workspace.ai_account_id`). The
 * key is sealed (server/secret-box.ts); `keyHint` is its last characters, so listing accounts
 * never opens it. Deleting the account (or the person's whole account) detaches it from every
 * workspace, which then falls back to the server's AI or none.
 */
export const aiAccount = pgTable(
  "ai_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    provider: text("provider").$type<OwnAiProvider>().notNull(),
    model: text("model").notNull(),
    /** Only for openai-compatible: the server's API root, reached through the guarded fetch (server/ai/fetch.ts). */
    baseUrl: text("base_url"),
    /** Sealed; null for an openai-compatible server without a key. */
    apiKey: text("api_key"),
    keyHint: text("key_hint"),
    /** Semantic search's model at the same provider; null leaves it off for the account's workspaces. */
    embeddingsModel: text("embeddings_model"),
    /** Voice notes' model at the same provider; null leaves them off. */
    sttModel: text("stt_model"),
    /** Workspaces created by the person attach their default account. One at most. */
    isDefault: boolean("is_default").notNull().default(false),
    /** `broken` after the provider refused the key; `active` again after a request goes through. */
    status: text("status").$type<AiAccountStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** When a test request last went through (on adding, changing, or Test again). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("ai_account_user_idx").on(t.userId),
    uniqueIndex("ai_account_default_idx").on(t.userId).where(sql`${t.isDefault}`),
    check(
      "ai_account_provider_check",
      sql`${t.provider} in ('anthropic', 'openai', 'google', 'openrouter', 'xai', 'moonshotai', 'minimax', 'zai', 'opencode-go', 'openai-compatible')`,
    ),
    check("ai_account_status_check", sql`${t.status} in ('active', 'broken')`),
  ],
);

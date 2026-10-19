/**
 * The own AI account a workspace's AI runs on (OWN_AI_KEYS_ENABLED, see server/ai-accounts.ts),
 * read from the database for each request. Only loaded while own keys are on (index.ts imports it
 * on demand), so a server without them never touches these tables for AI.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiAccount, workspace } from "@/db/schema";
import { env } from "@/lib/env";
import { findMembership } from "@/server/access";
import { open } from "@/server/secret-box";
import type { AiAccountSettings } from "./config";

export type WorkspaceAiAccount = {
  id: string;
  userId: string;
  status: "active" | "broken";
  /** Changes whenever what requests are sent with does: backends are cached by it. */
  fingerprint: string;
  settings: AiAccountSettings;
};

/**
 * The account attached to the workspace, while the person it belongs to is still a member there
 * (guests don't pay); null otherwise. Leaving takes it off too (releaseAiAccount); this check
 * covers every other way out.
 */
export async function workspaceAiAccount(workspaceId: string): Promise<WorkspaceAiAccount | null> {
  const [row] = await db
    .select({ account: aiAccount })
    .from(workspace)
    .innerJoin(aiAccount, eq(aiAccount.id, workspace.aiAccountId))
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (!row) return null;
  const a = row.account;
  const membership = await findMembership(a.userId, workspaceId);
  if (!membership || membership.role === "guest") return null;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([a.provider, a.model, a.baseUrl, a.apiKey, a.embeddingsModel, a.sttModel, env.aiAllowedHosts]))
    .digest("base64url");
  return {
    id: a.id,
    userId: a.userId,
    status: a.status,
    fingerprint,
    settings: {
      provider: a.provider,
      model: a.model,
      baseUrl: a.baseUrl,
      apiKey: a.apiKey ? open(a.apiKey) : null,
      embeddingsModel: a.embeddingsModel,
      sttModel: a.sttModel,
    },
  };
}

/**
 * Whether a provider's failure says the key itself is refused, rather than a passing problem or a
 * model the key may not use (a 403 is usually that: the key still works for other models).
 */
export function refusesKey(message: string) {
  return /\b401\b|unauthori[sz]ed|invalid[_ -]?(x-)?api[_ -]?key|incorrect api key|api key not valid|authentication_error/i.test(message);
}

/** Records that the provider refused the account's key: shown in its owner's settings. */
export async function markAccountBroken(id: string, message: string) {
  await db
    .update(aiAccount)
    .set({ status: "broken", lastError: message.slice(0, 1000), lastErrorAt: new Date() })
    .where(eq(aiAccount.id, id));
}

/** A request went through on an account marked broken: it works again. */
export async function markAccountWorking(id: string) {
  await db
    .update(aiAccount)
    .set({ status: "active", lastError: null, lastErrorAt: null, verifiedAt: sql`now()` })
    .where(and(eq(aiAccount.id, id), eq(aiAccount.status, "broken")));
}

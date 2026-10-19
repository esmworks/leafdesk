/**
 * People's own AI provider accounts (OWN_AI_KEYS_ENABLED): a key added once to the Leafdesk
 * account (Settings > Apps > AI), which workspaces its owner owns then run all their AI on. One
 * account pays for everything AI does in a workspace (members' requests and its background work
 * alike: AI properties, agents, automations, semantic search, voice notes, MCP), so a workspace
 * names one account and only that account's owner may attach it (`setWorkspaceAiAccount`). A
 * workspace its owner creates gets their default account.
 *
 * A key is tried with a tiny request before it is saved, sealed (server/secret-box.ts) and never
 * shown again: settings show its last characters. Only hosted providers and OpenAI-compatible
 * servers at a typed https address, checked like a connection's (server/ai/fetch.ts): a local
 * provider's default address would be the server's own machine.
 *
 * When the account's owner leaves a workspace or deletes the account (or their whole Leafdesk
 * account), the workspace falls back to the server's AI (unless AI_ONLY_OWN_KEYS), else none, and
 * its owners find out in their inbox (workspaces.ts, releaseAiAccount).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiAccount, user, workspace } from "@/db/schema";
import {
  EMBEDDING_PROVIDERS,
  isOwnAiProvider,
  keyHint,
  MAX_AI_ACCOUNT_LABEL,
  MAX_AI_ACCOUNTS,
  MAX_AI_BASE_URL,
  MAX_AI_KEY,
  MAX_AI_MODEL,
  STT_PROVIDERS,
  type AiAccountInput,
  type AiAccountView,
  type OwnAiProvider,
  type WorkspaceAiSource,
  type WorkspaceAiView,
} from "@/lib/ai-accounts";
import { env } from "@/lib/env";
import { redactText } from "@/lib/redact";
import { requireMembership } from "@/server/access";
import { aiTargetFor, forgetAiAccount, isAiError, serverAiServesWorkspaces, tryAiConfig } from "@/server/ai";
import { accountAiConfig, type AiAccountSettings } from "@/server/ai/config";
import { checkAiUrl, guardedAiFetch } from "@/server/ai/fetch";
import { recordAudit } from "@/server/audit";
import { open, seal } from "@/server/secret-box";
import { afterAiAccountReleased, tellOwnersAiAccountGone, type AiAccountRelease } from "@/server/workspaces";

export type AiAccountErrorCode =
  | "disabled"
  | "providerRequired"
  | "modelRequired"
  | "baseUrlRequired"
  | "baseUrlInvalid"
  | "keyRequired"
  | "keyTooLong"
  | "notFound"
  | "tooMany"
  | "testFailed";

/** `detail`: what the address check or the provider said, for baseUrlInvalid and testFailed. */
export class AiAccountError extends Error {
  constructor(
    readonly code: AiAccountErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
  }
}

function requireOwnKeys() {
  if (!env.ownAiKeysEnabled) throw new AiAccountError("disabled", "This server doesn't take people's own AI keys");
}

const PROVIDER_NAMES: Record<OwnAiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "opencode-go": "OpenCode Go",
  "openai-compatible": "OpenAI-compatible",
};

type Row = typeof aiAccount.$inferSelect;

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const optional = (value: unknown, max: number) => text(value, max) || null;

/**
 * Checks what someone typed against the provider's rules; `saved` is the account being changed,
 * whose key stays unless a new one is given. Throws AiAccountError("invalid").
 */
function readInput(input: AiAccountInput, saved: Row | null): { label: string; settings: AiAccountSettings } {
  const provider = input?.provider;
  if (!isOwnAiProvider(provider)) throw new AiAccountError("providerRequired", "Choose a provider");
  const model = text(input.model, MAX_AI_MODEL);
  if (!model) throw new AiAccountError("modelRequired", "Name the model");
  const typed = provider === "openai-compatible";
  let baseUrl: string | null = null;
  if (typed) {
    const raw = text(input.baseUrl, MAX_AI_BASE_URL + 1);
    if (!raw) throw new AiAccountError("baseUrlRequired", "Give the server's address");
    if (raw.length > MAX_AI_BASE_URL) throw new AiAccountError("baseUrlInvalid", "Not an address it can use", "The address is too long");
    try {
      baseUrl = checkAiUrl(raw).url;
    } catch (error) {
      throw new AiAccountError("baseUrlInvalid", "Not an address it can use", (error as Error).message);
    }
  }
  const typedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (typedKey.length > MAX_AI_KEY) throw new AiAccountError("keyTooLong", "The key is too long");
  // The saved key stays only for the same provider and address: a key never goes somewhere new unasked.
  const keepsKey = saved && saved.provider === provider && saved.baseUrl === baseUrl;
  const apiKey = typedKey || (keepsKey && saved.apiKey ? open(saved.apiKey) : null);
  if (!apiKey && !typed) throw new AiAccountError("keyRequired", "Paste the API key");
  const embeddingsModel = EMBEDDING_PROVIDERS.includes(provider) ? optional(input.embeddingsModel, MAX_AI_MODEL) : null;
  const sttModel = STT_PROVIDERS.includes(provider) ? optional(input.sttModel, MAX_AI_MODEL) : null;
  const label = text(input.label, MAX_AI_ACCOUNT_LABEL) || `${PROVIDER_NAMES[provider]} · ${model}`.slice(0, MAX_AI_ACCOUNT_LABEL);
  return { label, settings: { provider, model, baseUrl, apiKey, embeddingsModel, sttModel } };
}

/** Sends the account's tiny test request (and one embedding, when it names a model for them). */
async function tryAccount(settings: AiAccountSettings) {
  try {
    await tryAiConfig(accountAiConfig(settings, guardedAiFetch));
  } catch (error) {
    const message = isAiError(error) ? error.message : (error as Error).message;
    throw new AiAccountError("testFailed", "The test request failed", redactText(message).slice(0, 500));
  }
}

async function ownAccount(userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(aiAccount)
    .where(and(eq(aiAccount.id, String(id)), eq(aiAccount.userId, userId)))
    .limit(1);
  if (!row) throw new AiAccountError("notFound", "No such AI account");
  return row;
}

/** The person's own AI accounts, for their settings: never a key, only its last characters. */
export async function listAiAccounts(userId: string): Promise<AiAccountView[]> {
  requireOwnKeys();
  const rows = await db.select().from(aiAccount).where(eq(aiAccount.userId, userId)).orderBy(asc(aiAccount.createdAt));
  const used = rows.length
    ? await db
        .select({ accountId: workspace.aiAccountId, id: workspace.id, name: workspace.name })
        .from(workspace)
        .where(inArray(workspace.aiAccountId, rows.map((r) => r.id)))
        .orderBy(asc(workspace.name))
    : [];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    provider: r.provider,
    model: r.model,
    baseUrl: r.baseUrl,
    embeddingsModel: r.embeddingsModel,
    sttModel: r.sttModel,
    keyHint: r.keyHint,
    isDefault: r.isDefault,
    status: r.status,
    lastError: r.lastError,
    verifiedAt: r.verifiedAt.toISOString(),
    workspaces: used.filter((w) => w.accountId === r.id).map((w) => ({ id: w.id, name: w.name })),
  }));
}

/** Adds an account once its test request went through. The first one becomes the default. */
export async function addAiAccount(userId: string, input: AiAccountInput): Promise<AiAccountView[]> {
  requireOwnKeys();
  const { label, settings } = readInput(input, null);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiAccount).where(eq(aiAccount.userId, userId));
  if (count >= MAX_AI_ACCOUNTS) throw new AiAccountError("tooMany", `At most ${MAX_AI_ACCOUNTS} AI accounts`);
  await tryAccount(settings);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:ai-account:${userId}`}))`);
    const [first] = await tx.select({ id: aiAccount.id }).from(aiAccount).where(eq(aiAccount.userId, userId)).limit(1);
    await tx.insert(aiAccount).values({
      userId,
      label,
      ...stored(settings),
      isDefault: !first,
      status: "active",
      verifiedAt: new Date(),
    });
  });
  return listAiAccounts(userId);
}

const stored = (settings: AiAccountSettings) => ({
  provider: settings.provider as OwnAiProvider,
  model: settings.model,
  baseUrl: settings.baseUrl,
  apiKey: settings.apiKey ? seal(settings.apiKey) : null,
  keyHint: settings.apiKey ? keyHint(settings.apiKey) : null,
  embeddingsModel: settings.embeddingsModel,
  sttModel: settings.sttModel,
});

/**
 * Changes an account (a new key, model or address) once a test request with the change went
 * through. The workspaces on it use the change from their next request; a new embeddings model
 * indexes them again.
 */
export async function updateAiAccount(userId: string, id: string, input: AiAccountInput): Promise<AiAccountView[]> {
  requireOwnKeys();
  const saved = await ownAccount(userId, id);
  const { label, settings } = readInput(input, saved);
  await tryAccount(settings);
  await db
    .update(aiAccount)
    .set({ label, ...stored(settings), status: "active", lastError: null, lastErrorAt: null, verifiedAt: new Date() })
    .where(eq(aiAccount.id, saved.id));
  forgetAiAccount(saved.id);
  if (saved.embeddingsModel !== settings.embeddingsModel) await reindexWorkspacesOn(saved.id);
  return listAiAccounts(userId);
}

/** Tries the saved account again (Test): marks it working, or broken with what the provider said. */
export async function testAiAccount(userId: string, id: string): Promise<AiAccountView[]> {
  requireOwnKeys();
  const saved = await ownAccount(userId, id);
  const settings: AiAccountSettings = {
    provider: saved.provider,
    model: saved.model,
    baseUrl: saved.baseUrl,
    apiKey: saved.apiKey ? open(saved.apiKey) : null,
    embeddingsModel: saved.embeddingsModel,
    sttModel: saved.sttModel,
  };
  try {
    await tryAccount(settings);
    await db.update(aiAccount).set({ status: "active", lastError: null, lastErrorAt: null, verifiedAt: new Date() }).where(eq(aiAccount.id, saved.id));
  } catch (error) {
    if (!(error instanceof AiAccountError)) throw error;
    await db
      .update(aiAccount)
      .set({ status: "broken", lastError: error.detail ?? error.message, lastErrorAt: new Date() })
      .where(eq(aiAccount.id, saved.id));
  }
  return listAiAccounts(userId);
}

/** Makes the account the one the person's new workspaces get. */
export async function setDefaultAiAccount(userId: string, id: string): Promise<AiAccountView[]> {
  requireOwnKeys();
  const saved = await ownAccount(userId, id);
  await db.transaction(async (tx) => {
    await tx.update(aiAccount).set({ isDefault: false }).where(and(eq(aiAccount.userId, userId), ne(aiAccount.id, saved.id)));
    await tx.update(aiAccount).set({ isDefault: true }).where(eq(aiAccount.id, saved.id));
  });
  return listAiAccounts(userId);
}

/**
 * Deletes the account and its key. Workspaces on it fall back to the server's AI, or none; their
 * other owners find out in their inbox.
 */
export async function deleteAiAccount(userId: string, id: string): Promise<AiAccountView[]> {
  requireOwnKeys();
  const saved = await ownAccount(userId, id);
  const released = await db.transaction(async (tx) => {
    const used = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.aiAccountId, saved.id)).for("update");
    const out: AiAccountRelease[] = [];
    for (const w of used) out.push({ workspaceId: w.id, notificationIds: await tellOwnersAiAccountGone(tx, w.id, userId) });
    await tx.delete(aiAccount).where(eq(aiAccount.id, saved.id));
    // Another account takes over as the default, so new workspaces still get one.
    if (saved.isDefault) {
      await tx.execute(
        sql`update ${aiAccount} set is_default = true where id = (select id from ${aiAccount} where user_id = ${userId} order by created_at limit 1)`,
      );
    }
    return out;
  });
  forgetAiAccount(saved.id);
  await afterAiAccountReleased(released);
  return listAiAccounts(userId);
}

async function reindexWorkspacesOn(accountId: string) {
  const { reindexWorkspace } = await import("@/server/semantic-index");
  const used = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.aiAccountId, accountId));
  for (const w of used) await reindexWorkspace(w.id).catch((error) => console.error("[ai] could not index a workspace again", error));
}

// ------------------------------------------------------------------------------- workspaces

/** Where the workspace's AI comes from, for its settings; null while own keys are off. */
export async function workspaceAiView(userId: string, workspaceId: string): Promise<WorkspaceAiView | null> {
  if (!env.ownAiKeysEnabled) return null;
  const membership = await requireMembership(userId, workspaceId);
  const owner = membership.role === "owner";
  const target = await aiTargetFor(workspaceId);
  let source: WorkspaceAiSource;
  if (target?.accountId) {
    const [row] = await db
      .select({ id: aiAccount.id, label: aiAccount.label, provider: aiAccount.provider, model: aiAccount.model, ownerId: aiAccount.userId, ownerName: user.name })
      .from(aiAccount)
      .innerJoin(user, eq(user.id, aiAccount.userId))
      .where(eq(aiAccount.id, target.accountId))
      .limit(1);
    source = row
      ? { kind: "account", accountId: row.id, label: row.label, provider: row.provider, model: row.model, ownerId: row.ownerId, ownerName: row.ownerName, mine: row.ownerId === userId }
      : { kind: "off" };
  } else source = target?.config.chat ? { kind: "instance" } : { kind: "off" };
  const mine = owner
    ? await db
        .select({ id: aiAccount.id, label: aiAccount.label, provider: aiAccount.provider, model: aiAccount.model, status: aiAccount.status })
        .from(aiAccount)
        .where(eq(aiAccount.userId, userId))
        .orderBy(asc(aiAccount.createdAt))
    : [];
  return { source, mine, canChange: owner, onlyOwnKeys: env.aiOnlyOwnKeys, serverAi: serverAiServesWorkspaces() };
}

/**
 * Runs the workspace's AI on one of the viewer's own accounts, or on none (`accountId` null: the
 * server's AI, if workspaces may use it). Owners only, and only their own accounts: whoever pays
 * says so. Its semantic search index is made again with the model it has now.
 */
export async function setWorkspaceAiAccount(userId: string, workspaceId: string, accountId: string | null): Promise<WorkspaceAiView | null> {
  requireOwnKeys();
  await requireMembership(userId, workspaceId, "owner");
  const account = accountId ? await ownAccount(userId, accountId) : null;
  const [before] = await db
    .select({ id: aiAccount.id, label: aiAccount.label })
    .from(workspace)
    .innerJoin(aiAccount, eq(aiAccount.id, workspace.aiAccountId))
    .where(eq(workspace.id, workspaceId));
  if ((before?.id ?? null) === (account?.id ?? null)) return workspaceAiView(userId, workspaceId);
  await db.update(workspace).set({ aiAccountId: account?.id ?? null }).where(eq(workspace.id, workspaceId));
  await recordAudit(
    account
      ? { workspaceId, actorId: userId, action: "ai_account.attached", target: { type: "ai_account", id: account.id, label: account.label } }
      : { workspaceId, actorId: userId, action: "ai_account.detached", target: { type: "ai_account", id: before!.id, label: before!.label } },
  );
  const { reindexWorkspace } = await import("@/server/semantic-index");
  await reindexWorkspace(workspaceId).catch((error) => console.error("[ai] could not index a workspace again", error));
  return workspaceAiView(userId, workspaceId);
}

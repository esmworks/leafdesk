import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, workspace } from "@/db/schema";
import { ALL_API_SCOPES, effectiveScopes, isApiTokenScope, isOwnerScope, normalizeScopes, type ApiTokenScope } from "@/lib/api-scopes";
import { findMembership, memberWorkspaceIds, signInPolicyRefusal } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { forgetApiTokenUse } from "@/server/connected-app-use";

/**
 * Personal access tokens for the REST API. A token is `esi_` plus 40 letters and digits (about 238
 * bits), so secret scanners can recognize it by /esi_[A-Za-z0-9]{40}/. Only its SHA-256 hash is
 * stored; a fast hash is enough for a random secret of that length.
 */
export const TOKEN_PREFIX = "esi_";
const SECRET_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_LENGTH = 40;
export const TOKEN_PATTERN = /^esi_[A-Za-z0-9]{40}$/;
/** How much of the secret lists show, to tell tokens apart ("esi_Ab12"). */
const SHOWN_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;

export const MAX_TOKEN_NAME = 100;
export const MAX_TOKENS_PER_USER = 50;
export const MAX_EXPIRY_DAYS = 3650;
/** lastUsedAt is written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;

export class ApiTokenError extends Error {
  constructor(
    message: string,
    readonly code: "name" | "scopes" | "ownerScope" | "workspace" | "expiry" | "limit" | "notFound",
  ) {
    super(message);
    this.name = "ApiTokenError";
  }
}

/** A new random secret, drawn without modulo bias. */
export function generateTokenSecret(): string {
  let out = "";
  while (out.length < SECRET_LENGTH) {
    for (const byte of randomBytes(64)) {
      // 248 = 4 × 62: bytes above it would favour the first characters.
      if (byte < 248) out += SECRET_CHARS[byte % 62];
      if (out.length === SECRET_LENGTH) break;
    }
  }
  return TOKEN_PREFIX + out;
}

export const hashToken = (secret: string) => createHash("sha256").update(secret).digest("hex");

type StoredToken = { id: string; name: string; workspaceId: string | null; scopes: string[]; legacyScopes: boolean };

/**
 * Records a token's creation, change or revocation in the audit log of the workspace it is limited
 * to, or of every workspace its user is in when it reaches all of them.
 */
async function recordToken(
  userId: string,
  token: StoredToken,
  action: "api_token.created" | "api_token.updated" | "api_token.revoked",
  extra: Record<string, unknown> = {},
) {
  const workspaceIds = token.workspaceId ? [token.workspaceId] : await memberWorkspaceIds(userId);
  await recordAudit(
    workspaceIds.map((workspaceId) => ({
      workspaceId,
      actorId: userId,
      action,
      target: { type: "api_token" as const, id: token.id, label: token.name },
      details: { scopes: effectiveScopes(token.scopes, token.legacyScopes), allWorkspaces: token.workspaceId === null, ...extra },
    })),
  );
}

/** The scopes asked for, as stored; refused when none or any unknown. */
function checkedScopes(scopes: readonly string[]) {
  const normalized = normalizeScopes(scopes);
  if (!normalized.length || !scopes.every(isApiTokenScope)) {
    throw new ApiTokenError(`Scopes must be some of ${ALL_API_SCOPES.join(", ")}`, "scopes");
  }
  return normalized;
}

/**
 * Owner-only scopes (the audit log) go only to a token of one workspace, which `userId` owns now.
 * Its calls check again that they still do.
 */
async function checkOwnerScopes(userId: string, workspaceId: string | null, scopes: readonly string[]) {
  if (!scopes.some(isOwnerScope)) return;
  const membership = workspaceId ? await findMembership(userId, workspaceId) : null;
  if (membership?.role !== "owner") {
    throw new ApiTokenError("Only a workspace's owners can let a token read its audit log, and only a token for that workspace", "ownerScope");
  }
}

export type NewApiToken = {
  name: string;
  scopes: readonly string[];
  /** Restrict the token to this workspace; null for all of the user's workspaces. */
  workspaceId?: string | null;
  /** Days until it stops working; null never expires. */
  expiresInDays?: number | null;
};

export type ApiTokenInfo = {
  id: string;
  name: string;
  prefix: string;
  /** What it may do, a legacy token's scopes read as what they stand for. */
  scopes: ApiTokenScope[];
  /** Made before scopes were per resource (see lib/api-scopes.ts). */
  legacyScopes: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

/** Creates a token for `userId` and returns its secret, which is not stored and can't be shown again. */
export async function createApiToken(userId: string, input: NewApiToken, now = new Date()) {
  const name = input.name.trim();
  if (!name || name.length > MAX_TOKEN_NAME) throw new ApiTokenError(`Give the token a name of at most ${MAX_TOKEN_NAME} characters`, "name");
  const scopes = checkedScopes(input.scopes);
  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)) {
    throw new ApiTokenError(`Tokens expire after 1 to ${MAX_EXPIRY_DAYS} days, or never`, "expiry");
  }
  const workspaceId = input.workspaceId || null;
  // The user's standing, not the request's session: tokens are outside the sign-in policies.
  if (workspaceId && !(await findMembership(userId, workspaceId))) {
    throw new ApiTokenError("You are not a member of that workspace", "workspace");
  }
  // Which is why a session a workspace's policy holds back can't make one that reaches it: one
  // for that workspace, or one for all of them while any of them holds it back.
  const refusal = await signInPolicyRefusal(userId, workspaceId ? [workspaceId] : await memberWorkspaceIds(userId));
  if (refusal) throw refusal;
  await checkOwnerScopes(userId, workspaceId, scopes);
  const [{ n }] = await db.select({ n: count() }).from(apiToken).where(eq(apiToken.userId, userId));
  if (n >= MAX_TOKENS_PER_USER) throw new ApiTokenError(`You can have at most ${MAX_TOKENS_PER_USER} tokens; revoke one first`, "limit");
  const secret = generateTokenSecret();
  const [row] = await db
    .insert(apiToken)
    .values({
      userId,
      name,
      prefix: secret.slice(0, SHOWN_PREFIX_LENGTH),
      tokenHash: hashToken(secret),
      scopes,
      workspaceId,
      expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
      createdAt: now,
    })
    .returning();
  await recordToken(userId, row, "api_token.created");
  return { secret, token: row };
}

export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const rows = await db
    .select({
      id: apiToken.id,
      name: apiToken.name,
      prefix: apiToken.prefix,
      scopes: apiToken.scopes,
      legacyScopes: apiToken.legacyScopes,
      workspaceId: apiToken.workspaceId,
      workspaceName: workspace.name,
      expiresAt: apiToken.expiresAt,
      lastUsedAt: apiToken.lastUsedAt,
      createdAt: apiToken.createdAt,
    })
    .from(apiToken)
    .leftJoin(workspace, eq(workspace.id, apiToken.workspaceId))
    .where(eq(apiToken.userId, userId))
    .orderBy(desc(apiToken.createdAt));
  return rows.map((r) => ({ ...r, scopes: effectiveScopes(r.scopes, r.legacyScopes) }));
}

/**
 * Changes what one of the user's tokens may do, keeping its secret: it gets exactly these scopes,
 * a legacy token too (it stops standing for "everything" then). Takes effect on its next request.
 */
export async function updateApiTokenScopes(userId: string, tokenId: string, scopes: readonly string[]) {
  const next = checkedScopes(scopes);
  const updated = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ scopes: apiToken.scopes, legacyScopes: apiToken.legacyScopes, workspaceId: apiToken.workspaceId })
      .from(apiToken)
      .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, userId)))
      .for("update");
    if (!before) return null;
    await checkOwnerScopes(userId, before.workspaceId, next);
    const [row] = await tx
      .update(apiToken)
      .set({ scopes: next, legacyScopes: false })
      .where(eq(apiToken.id, tokenId))
      .returning({ id: apiToken.id, name: apiToken.name, workspaceId: apiToken.workspaceId, scopes: apiToken.scopes, legacyScopes: apiToken.legacyScopes });
    return { row, previous: effectiveScopes(before.scopes, before.legacyScopes) };
  });
  if (!updated) throw new ApiTokenError("You have no such token", "notFound");
  await recordToken(userId, updated.row, "api_token.updated", { previousScopes: updated.previous });
  return { ...updated.row, scopes: next };
}

/**
 * Deletes one of the user's tokens; false when they have no such token. `by`: a workspace's owner
 * revoking someone else's token from its settings; only that workspace records it, with the owner
 * as who did it.
 */
export async function revokeApiToken(userId: string, tokenId: string, by?: { actorId: string; workspaceId: string }): Promise<boolean> {
  const deleted = await db
    .delete(apiToken)
    .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, userId)))
    .returning({ id: apiToken.id, name: apiToken.name, workspaceId: apiToken.workspaceId, scopes: apiToken.scopes, legacyScopes: apiToken.legacyScopes });
  await forgetApiTokenUse({ tokenIds: deleted.map((t) => t.id) }).catch((error) =>
    console.error("[api-tokens] could not forget when a token was last used", error),
  );
  for (const token of deleted) {
    if (!by || by.actorId === userId) await recordToken(userId, token, "api_token.revoked");
    else {
      await recordAudit({
        workspaceId: by.workspaceId,
        actorId: by.actorId,
        action: "api_token.revoked",
        target: { type: "api_token", id: token.id, label: token.name },
        subject: { type: "user", id: userId },
        details: { scopes: effectiveScopes(token.scopes, token.legacyScopes), allWorkspaces: token.workspaceId === null },
      });
    }
  }
  return deleted.length > 0;
}

export async function revokeAllApiTokens(userId: string) {
  await db.delete(apiToken).where(eq(apiToken.userId, userId));
  await afterApiTokensRevoked(userId);
}

/**
 * Deletes every API token of these people inside the caller's transaction, so they stop working
 * together with whatever else it changes. Returns how many; once the transaction commits, call
 * afterApiTokensRevoked for each person.
 */
export async function revokeApiTokensIn(tx: Pick<typeof db, "delete">, userIds: string[]) {
  if (!userIds.length) return 0;
  const deleted = await tx.delete(apiToken).where(inArray(apiToken.userId, userIds)).returning({ id: apiToken.id });
  return deleted.length;
}

export async function afterApiTokensRevoked(userId: string) {
  // It runs where an account is being secured: once the tokens are gone, nothing after may fail.
  await forgetApiTokenUse({ userId }).catch((error) => console.error("[api-tokens] could not forget when tokens were last used", error));
}

/** Who a verified token acts for, and what it may do. */
export type ApiPrincipal = {
  tokenId: string;
  userId: string;
  /** What it may do, a legacy token's scopes read as what they stand for. */
  scopes: ApiTokenScope[];
  legacyScopes: boolean;
  workspaceId: string | null;
  expiresAt: Date | null;
};

export type TokenCheck = { ok: true; principal: ApiPrincipal } | { ok: false; reason: "invalid" | "expired" };

/** Looks a presented secret up. Records when the token was last used (at most once a minute). */
export async function verifyApiToken(secret: string, now = new Date()): Promise<TokenCheck> {
  if (!TOKEN_PATTERN.test(secret)) return { ok: false, reason: "invalid" };
  const [row] = await db.select().from(apiToken).where(eq(apiToken.tokenHash, hashToken(secret))).limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    // Waits for a transaction deleting the token meanwhile (revoking it, or cutting off its owner's
    // sign-ins), and then finds it gone.
    const touched = await db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, row.id)).returning({ id: apiToken.id });
    if (!touched.length) return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    principal: {
      tokenId: row.id,
      userId: row.userId,
      scopes: effectiveScopes(row.scopes, row.legacyScopes),
      legacyScopes: row.legacyScopes,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
    },
  };
}

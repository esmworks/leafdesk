import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { API_TOKEN_SCOPES, apiToken, workspace, type ApiTokenScope } from "@/db/schema";
import { findMembership, memberWorkspaceIds, signInPolicyRefusal } from "@/server/access";
import { recordAudit } from "@/server/audit";

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
    readonly code: "name" | "scopes" | "workspace" | "expiry" | "limit",
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

/** Scopes as stored: known ones only, and pages:write always brings pages:read. */
export function normalizeScopes(scopes: readonly string[]): ApiTokenScope[] {
  const known = new Set(scopes.filter((s): s is ApiTokenScope => (API_TOKEN_SCOPES as readonly string[]).includes(s)));
  if (known.has("pages:write")) known.add("pages:read");
  return API_TOKEN_SCOPES.filter((s) => known.has(s));
}

/**
 * Records a token's creation or revocation in the audit log of the workspace it is limited to, or
 * of every workspace its user is in when it reaches all of them.
 */
async function recordToken(
  userId: string,
  token: { id: string; name: string; workspaceId: string | null; scopes: string[] },
  action: "api_token.created" | "api_token.revoked",
) {
  const workspaceIds = token.workspaceId ? [token.workspaceId] : await memberWorkspaceIds(userId);
  await recordAudit(
    workspaceIds.map((workspaceId) => ({
      workspaceId,
      actorId: userId,
      action,
      target: { type: "api_token" as const, id: token.id, label: token.name },
      details: { scopes: normalizeScopes(token.scopes), allWorkspaces: token.workspaceId === null },
    })),
  );
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
  scopes: ApiTokenScope[];
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
  const scopes = normalizeScopes(input.scopes);
  const unknown = input.scopes.some((s) => !(API_TOKEN_SCOPES as readonly string[]).includes(s));
  if (!scopes.length || unknown) throw new ApiTokenError(`Scopes must be ${API_TOKEN_SCOPES.join(" and/or ")}`, "scopes");
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
  return rows.map((r) => ({ ...r, scopes: normalizeScopes(r.scopes) }));
}

/** Deletes one of the user's tokens; false when they have no such token. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const deleted = await db
    .delete(apiToken)
    .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, userId)))
    .returning({ id: apiToken.id, name: apiToken.name, workspaceId: apiToken.workspaceId, scopes: apiToken.scopes });
  for (const token of deleted) await recordToken(userId, token, "api_token.revoked");
  return deleted.length > 0;

}

export async function revokeAllApiTokens(userId: string) {
  await db.delete(apiToken).where(eq(apiToken.userId, userId));
}

/** Who a verified token acts for, and what it may do. */
export type ApiPrincipal = {
  tokenId: string;
  userId: string;
  scopes: ApiTokenScope[];
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
    await db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, row.id));
  }
  return {
    ok: true,
    principal: {
      tokenId: row.id,
      userId: row.userId,
      scopes: normalizeScopes(row.scopes),
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
    },
  };
}

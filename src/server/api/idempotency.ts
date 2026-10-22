import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiIdempotencyKey, apiToken } from "@/db/schema";

/**
 * Idempotency keys for the REST API's writes. A client that sends `Idempotency-Key: <key>` with a
 * POST, PATCH, PUT or DELETE can send the same request again (after a timeout, a dropped
 * connection) and gets the first answer back, marked `Idempotent-Replayed: true`, instead of the
 * change being made twice.
 *
 * A key belongs to one token and one operation (the method and route, "PATCH /rows/{row_id}"), and
 * remembers a hash of the request: its path, query and body. The same key with another request
 * (another row, another body) is refused, as is the same key while its first request is still
 * running. Answers of 5xx are not kept, nor 429s, so a retry runs the request again. Keys last 24
 * hours from their first request; the daily retention run deletes older ones.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
export const MAX_IDEMPOTENCY_KEY = 255;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A request still marked as running after this long was cut off (the server stopped): its key is free again. */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export type StoredResponse = { status: number; body: string };

export type Claim =
  /** The key is the request's now: run it, then complete or release it. */
  | { kind: "claimed" }
  /** The key's request was answered: send that answer again. */
  | { kind: "replay"; response: StoredResponse }
  /** The key's first request is still running. */
  | { kind: "running" }
  /** The key was used for another request. */
  | { kind: "reused" };

export type IdempotencyEntry = { tokenId: string; operation: string; key: string; requestHash: string };
export type IdempotencyId = Omit<IdempotencyEntry, "requestHash">;

export type IdempotencyStore = {
  claim(entry: IdempotencyEntry, now?: Date): Promise<Claim>;
  /** Keeps the answer for retries. */
  complete(id: IdempotencyId, response: StoredResponse): Promise<void>;
  /** Forgets a claim whose request failed, so a retry runs it again. */
  release(id: IdempotencyId): Promise<void>;
};

/** Whether an answer is kept for retries: not server failures nor rate limits, which a retry may get past. */
export const keepsAnswer = (status: number) => status < 500 && status !== 429;

/** A value as JSON with object keys sorted, so the same request always hashes alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const requestHashOf = (request: { method: string; path: string; query: Record<string, string>; body: unknown }) =>
  createHash("sha256").update(canonicalJson(request)).digest("hex");

const where = (id: IdempotencyId) =>
  and(eq(apiIdempotencyKey.tokenId, id.tokenId), eq(apiIdempotencyKey.operation, id.operation), eq(apiIdempotencyKey.key, id.key));

/** Keys kept in the database, shared by the app's processes. */
export const databaseIdempotencyStore: IdempotencyStore = {
  async claim(entry, now = new Date()) {
    // A key past its 24 hours, or a claim whose request was cut off, makes way for this request.
    await db
      .delete(apiIdempotencyKey)
      .where(
        and(
          where(entry),
          or(
            lte(apiIdempotencyKey.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)),
            and(isNull(apiIdempotencyKey.status), lte(apiIdempotencyKey.createdAt, new Date(now.getTime() - STALE_CLAIM_MS))),
          ),
        ),
      );
    // Twice at most: a request that held the key may fail and release it in between.
    for (let attempt = 0; ; attempt++) {
      // Of requests racing for a key, one inserts it; the others find it there.
      const inserted = await db
        .insert(apiIdempotencyKey)
        .values({ ...entry, createdAt: now })
        .onConflictDoNothing()
        .returning({ key: apiIdempotencyKey.key });
      if (inserted.length) return { kind: "claimed" };
      const [row] = await db
        .select({ requestHash: apiIdempotencyKey.requestHash, status: apiIdempotencyKey.status, response: apiIdempotencyKey.response })
        .from(apiIdempotencyKey)
        .where(where(entry));
      if (!row) {
        if (attempt === 0) continue;
        return { kind: "running" };
      }
      if (row.requestHash !== entry.requestHash) return { kind: "reused" };
      if (row.status === null) return { kind: "running" };
      return { kind: "replay", response: { status: row.status, body: row.response ?? "" } };
    }
  },
  async complete(id, response) {
    await db.update(apiIdempotencyKey).set({ status: response.status, response: response.body }).where(where(id));
  },
  async release(id) {
    await db.delete(apiIdempotencyKey).where(and(where(id), isNull(apiIdempotencyKey.status)));
  },
};

/**
 * Deletes the keys older than 24 hours at `now`. `workspaceIds` narrows it to keys of tokens
 * limited to those workspaces (the retention run's e2e narrowing; keys belong to tokens, not
 * workspaces). Returns how many went.
 */
export async function pruneIdempotencyKeys({ now = new Date(), workspaceIds }: { now?: Date; workspaceIds?: string[] } = {}) {
  if (workspaceIds?.length === 0) return 0;
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  const scoped = workspaceIds
    ? inArray(apiIdempotencyKey.tokenId, db.select({ id: apiToken.id }).from(apiToken).where(inArray(apiToken.workspaceId, workspaceIds)))
    : sql`true`;
  const deleted = await db
    .delete(apiIdempotencyKey)
    .where(and(lte(apiIdempotencyKey.createdAt, cutoff), scoped))
    .returning({ key: apiIdempotencyKey.key });
  return deleted.length;
}

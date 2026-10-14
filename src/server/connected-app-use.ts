import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, connectedAppUse, oauthConsent } from "@/db/schema";
import type { ConnectedAppIdentity } from "@/server/connected-app";

/** A row is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** Past this many remembered rows the memory starts over (a row may then be written early once). */
const MAX_REMEMBERED = 10_000;

// When this process last wrote each row, so most requests write nothing.
const globalForUse = globalThis as unknown as { __leafdeskAppUse?: Map<string, number> };
const written = (globalForUse.__leafdeskAppUse ??= new Map<string, number>());

/**
 * Records that a connected app reached a workspace for its user, without waiting: a failed write is
 * only logged, never the request's error. At most once a minute per workspace, user and app.
 */
export function noteConnectedAppUse(userId: string, app: ConnectedAppIdentity, workspaceId: string, now = Date.now()) {
  const key = `${workspaceId}|${userId}|${app.kind}|${app.id}`;
  const last = written.get(key);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
  if (written.size >= MAX_REMEMBERED) written.clear();
  written.set(key, now);
  const at = new Date(now);
  // Only while the app is still connected (the token still there): a request that was under way
  // when it was disconnected doesn't bring back when it was used.
  const connected =
    app.kind === "connected_app"
      ? sql`exists (select 1 from ${oauthConsent} where ${oauthConsent.userId} = ${userId} and ${oauthConsent.clientId} = ${app.id})`
      : sql`exists (select 1 from ${apiToken} where ${apiToken.id} = ${app.id})`;
  void db
    .execute(
      sql`insert into ${connectedAppUse} (workspace_id, user_id, app_kind, app_id, last_used_at)
        select ${workspaceId}, ${userId}, ${app.kind}, ${app.id}, ${at.toISOString()}::timestamptz where ${connected}
        on conflict (workspace_id, user_id, app_kind, app_id)
        do update set last_used_at = greatest(${connectedAppUse}.last_used_at, excluded.last_used_at)`,
    )
    .catch((error) => console.error("[connected-apps] could not record when an app was last used", error));
}

/** Forgets when the user's app (an OAuth client id, or every client when omitted) was last used. */
export async function forgetConnectedAppUse(userId: string, clientId?: string) {
  written.clear();
  await db
    .delete(connectedAppUse)
    .where(
      and(
        eq(connectedAppUse.userId, userId),
        eq(connectedAppUse.appKind, "connected_app"),
        clientId === undefined ? undefined : eq(connectedAppUse.appId, clientId),
      ),
    );
}

/** Forgets when API tokens were last used: these (by id), or every token of the user. */
export async function forgetApiTokenUse(target: { tokenIds: string[] } | { userId: string }) {
  if ("tokenIds" in target && !target.tokenIds.length) return;
  written.clear();
  await db
    .delete(connectedAppUse)
    .where(
      and(
        eq(connectedAppUse.appKind, "api_token"),
        "userId" in target ? eq(connectedAppUse.userId, target.userId) : inArray(connectedAppUse.appId, target.tokenIds),
      ),
    );
}

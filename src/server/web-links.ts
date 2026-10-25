/**
 * Web links that stopped working (lib/web-links). The workspace check asks about the addresses of
 * the pages it looks at (`wantWebLinks`) and reads what is known of them (`webLinkStates`); a
 * background job fetches the addresses not checked lately (`runWebLinkChecks`), a few at a time and
 * few per site, through the same guard as saving a web page (connections/fetch.ts with `web`):
 * public addresses only, unless CONNECTOR_ALLOWED_HOSTS lets a host through. Nothing of an answer is
 * kept but its status. WEB_LINK_CHECKS=off stops it all.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { webLinkCheck } from "@/db/schema";
import { env } from "@/lib/env";
import {
  classifyAnswer,
  classifyFailure,
  recheckAfterMs,
  WEB_LINK_FORGET_DAYS,
  type WebLinkResult,
  type WebLinkStatus,
} from "@/lib/web-links";
import { connectionFetch, ConnectionFetchError } from "@/server/connections/fetch";
import { startSweep } from "@/server/sweep";

const SWEEP_INTERVAL_MS = 60_000;
/** Addresses fetched per round, at most this many at once and this many of one site. */
const PER_ROUND = 40;
const AT_ONCE = 6;
const PER_HOST = 3;
const TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WebLinkState = { status: WebLinkStatus; httpStatus: number | null; reason: string | null; failures: number; checkedAt: Date | null };

/** Whether this server checks web links at all (WEB_LINK_CHECKS). */
export const webLinkChecksEnabled = () => env.webLinkChecks;

/** Notes that a workspace check asked about these addresses now: new ones wait for the job. */
export async function wantWebLinks(workspaceId: string, urls: string[], now = new Date()) {
  for (let i = 0; i < urls.length; i += 500) {
    const part = urls.slice(i, i + 500);
    await db
      .insert(webLinkCheck)
      .values(part.map((url) => ({ workspaceId, url, wantedAt: now })))
      .onConflictDoUpdate({ target: [webLinkCheck.workspaceId, webLinkCheck.url], set: { wantedAt: now } });
  }
}

/** What is known of these addresses of the workspace, by address. */
export async function webLinkStates(workspaceId: string, urls: string[]): Promise<Map<string, WebLinkState>> {
  const out = new Map<string, WebLinkState>();
  for (let i = 0; i < urls.length; i += 1000) {
    const rows = await db
      .select({
        url: webLinkCheck.url,
        status: webLinkCheck.status,
        httpStatus: webLinkCheck.httpStatus,
        reason: webLinkCheck.reason,
        failures: webLinkCheck.failures,
        checkedAt: webLinkCheck.checkedAt,
      })
      .from(webLinkCheck)
      .where(and(eq(webLinkCheck.workspaceId, workspaceId), inArray(webLinkCheck.url, urls.slice(i, i + 1000))));
    for (const { url, ...state } of rows) out.set(url, state);
  }
  return out;
}

/** The code of a failed fetch: undici puts the system's (ENOTFOUND, ECONNREFUSED …) on its cause. */
function errorCode(error: unknown): string | undefined {
  let e = error as { code?: unknown; cause?: unknown; name?: unknown } | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === "string") return e.code;
    if (e.name === "TimeoutError" || e.name === "AbortError") return "ETIMEDOUT";
    e = e.cause as typeof e;
  }
  return undefined;
}

/**
 * Fetches `url` and says whether it works: HEAD first, and GET when HEAD gets an error (many
 * servers answer HEAD badly), reading no body. `fetcher` is for tests.
 */
export async function checkWebLink(url: string, fetcher: typeof connectionFetch = connectionFetch): Promise<WebLinkResult> {
  const headers = { "user-agent": `Leafdesk link check (+${env.appUrl})`, accept: "text/html,*/*;q=0.8" };
  let last: WebLinkResult | null = null;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const response = await fetcher(url, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) }, { web: true });
      await response.body?.cancel().catch(() => undefined);
      last = classifyAnswer(response.status);
      if (response.status < 400) return last;
    } catch (error) {
      if (error instanceof ConnectionFetchError) return { status: "skipped", httpStatus: null, reason: null };
      if (errorCode(error) === "EBLOCKED") return { status: "skipped", httpStatus: null, reason: null };
      // GET won't reach what HEAD couldn't.
      return last ?? classifyFailure(errorCode(error));
    }
  }
  return last!;
}

/**
 * One round of checks as of `now`: forgets addresses nobody asked about for WEB_LINK_FORGET_DAYS,
 * then fetches the ones due (never checked first), each address once however many workspaces
 * hold it. A round where nothing answered at all says more about this server's network than about
 * the links: nothing is recorded then but that they were tried. `fetcher` is for tests.
 */
export async function runWebLinkChecks(now = new Date(), { fetcher = connectionFetch, limit = PER_ROUND } = {}) {
  if (!webLinkChecksEnabled()) return { checked: 0 };
  await db.delete(webLinkCheck).where(lt(webLinkCheck.wantedAt, new Date(now.getTime() - WEB_LINK_FORGET_DAYS * DAY_MS)));

  const stamp = now.toISOString();
  const due = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ workspace_id: string; url: string; status: WebLinkStatus; failures: number }>(sql`
      select workspace_id, url, status, failures from ${webLinkCheck}
      where checked_at is null
        or checked_at < ${stamp}::timestamptz - (case status
          when 'ok' then ${recheckAfterMs("ok")}::bigint when 'broken' then ${recheckAfterMs("broken")}::bigint
          when 'skipped' then ${recheckAfterMs("skipped")}::bigint else ${recheckAfterMs("unreachable")}::bigint end) * interval '1 millisecond'
      order by checked_at nulls first, wanted_at desc
      limit ${limit * 10}
      for update skip locked
    `);
    // A few of one site per round, so no site gets many requests at once.
    const perHost = new Map<string, number>();
    const picked: (typeof rows)[number][] = [];
    const urls = new Set<string>();
    for (const row of rows) {
      if (urls.size >= limit && !urls.has(row.url)) continue;
      const host = new URL(row.url).hostname;
      if (!urls.has(row.url)) {
        if ((perHost.get(host) ?? 0) >= PER_HOST) continue;
        perHost.set(host, (perHost.get(host) ?? 0) + 1);
        urls.add(row.url);
      }
      picked.push(row);
    }
    // Claimed: another server (or the next round) leaves them alone while they are fetched.
    for (const row of picked) {
      await tx
        .update(webLinkCheck)
        .set({ checkedAt: now })
        .where(and(eq(webLinkCheck.workspaceId, row.workspace_id), eq(webLinkCheck.url, row.url)));
    }
    return picked;
  });
  if (!due.length) return { checked: 0 };

  const urls = [...new Set(due.map((r) => r.url))];
  const results = new Map<string, WebLinkResult>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, urls.length) }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        results.set(url, await checkWebLink(url, fetcher));
      }
    }),
  );
  const answered = [...results.values()].some((r) => r.status !== "unreachable" || r.httpStatus !== null);
  if (!answered && urls.length >= 3) return { checked: 0 };

  for (const row of due) {
    const result = results.get(row.url);
    if (!result) continue;
    const failing = result.status === "broken" || result.status === "unreachable";
    await db
      .update(webLinkCheck)
      .set({
        status: result.status,
        httpStatus: result.httpStatus,
        reason: result.reason,
        failures: failing ? row.failures + 1 : 0,
        checkedAt: now,
      })
      .where(and(eq(webLinkCheck.workspaceId, row.workspace_id), eq(webLinkCheck.url, row.url)));
  }
  return { checked: urls.length };
}

export function startWebLinkChecks() {
  if (!webLinkChecksEnabled()) return () => {};
  return startSweep(SWEEP_INTERVAL_MS, () => runWebLinkChecks(), "could not check web links");
}

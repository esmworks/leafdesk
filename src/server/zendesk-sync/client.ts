import {
  exportPage,
  parseZendeskQuery,
  ticketRow,
  usersOf,
  ZENDESK_PAGE_SIZE,
  ZENDESK_PER_RUN,
  ZENDESK_USERS_PER_REQUEST,
  type ZendeskQuery,
  type ZendeskRow,
  type ZendeskUser,
} from "@/lib/zendesk-sync";
import type { JiraErrorCode } from "@/lib/jira-sync";
import { checkConnectionUrl, ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { answerJson, JiraError } from "@/server/jira-sync/client";
import { syncFetchReach } from "@/server/sync-reach";

/**
 * Leafdesk's calls to Zendesk Support's REST API (lib/zendesk-sync), signed in with an email
 * address and API token (Basic auth, `email/token:token`). They go through the connections' fetch
 * like Jira's: https to a public address only, unless the host is in CONNECTOR_ALLOWED_HOSTS. An
 * error is a JiraError (the runs record every source's alike) with a code; it never carries the
 * answer's body or headers.
 */

export type ZendeskAuth = { email: string; token: string };

export class ZendeskError extends JiraError {
  constructor(code: JiraErrorCode, message: string = code) {
    super(code, message);
  }
}

const TIMEOUT_MS = 30_000;
/** The biggest answer read from Zendesk, in bytes: a page of a thousand tickets with their custom fields fits. */
const MAX_ANSWER_BYTES = 30_000_000;

/** Checks an account's address before anything is sent there. */
export function checkZendeskSite(siteUrl: string) {
  try {
    checkConnectionUrl(siteUrl, syncFetchReach());
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new ZendeskError("invalidSite", error.message);
    throw error;
  }
}

async function call(siteUrl: string, auth: ZendeskAuth, path: string): Promise<unknown> {
  checkZendeskSite(siteUrl);
  let response: Response;
  try {
    response = await connectionFetch(
      new URL(path, siteUrl),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${auth.email}/token:${auth.token}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      syncFetchReach(),
    );
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new ZendeskError("invalidSite", error.message);
    throw new ZendeskError("unreachable", "Zendesk could not be reached");
  }
  const body = await answerJson(response, MAX_ANSWER_BYTES);
  if (response.ok) {
    // Something answered that isn't Zendesk's API (a sign-in page, another app).
    if (body === undefined) throw new ZendeskError("notFound", "No Zendesk answered at this address");
    return body;
  }
  if (response.status === 401) throw new ZendeskError("unauthorized", "Zendesk refused the email address and API token");
  if (response.status === 403) throw new ZendeskError("forbidden", "This account may not export tickets (it needs the admin role)");
  if (response.status === 404) throw new ZendeskError("notFound", "No Zendesk answered at this address");
  // The export is limited to a few requests a minute: a spent limit passes, the next run tries again.
  if (response.status === 429 || response.status >= 500) throw new ZendeskError("unreachable", `Zendesk answered ${response.status}`);
  throw new ZendeskError("failed", `Zendesk answered ${response.status}`);
}

/** The signed-in person's name: checks the address, email and token. */
export async function zendeskAccount(siteUrl: string, auth: ZendeskAuth): Promise<{ name: string }> {
  const body = (await call(siteUrl, auth, "/api/v2/users/me.json")) as { user?: { id?: unknown; name?: unknown } } | null;
  if (!body || typeof body !== "object" || typeof body.user?.id !== "number") throw new ZendeskError("notFound", "No Zendesk answered at this address");
  return { name: typeof body.user.name === "string" && body.user.name ? body.user.name : auth.email };
}

/** The users of the account the tickets name, by id (a hundred a request). */
async function fetchUsers(siteUrl: string, auth: ZendeskAuth, ids: number[]): Promise<Map<number, ZendeskUser>> {
  const users = new Map<number, ZendeskUser>();
  for (let i = 0; i < ids.length; i += ZENDESK_USERS_PER_REQUEST) {
    const chunk = ids.slice(i, i + ZENDESK_USERS_PER_REQUEST);
    for (const [id, user] of usersOf(await call(siteUrl, auth, `/api/v2/users/show_many.json?ids=${chunk.join(",")}`))) users.set(id, user);
  }
  return users;
}

/**
 * The tickets changed since the sync's newest update, the users they name, and what to remember
 * for the next run. Reads the export page by page up to ZENDESK_PER_RUN tickets (the rest comes
 * next run); stops at its last page, a cursor that comes back or a missing one. A start time must be
 * at least a minute in the past.
 */
export async function fetchTickets(
  siteUrl: string,
  auth: ZendeskAuth,
  state: ZendeskQuery,
  now = Date.now(),
): Promise<{ rows: ZendeskRow[]; users: Map<number, ZendeskUser>; next: ZendeskQuery }> {
  const rows: ZendeskRow[] = [];
  const seenIds = new Set<number>();
  const seenCursors = new Set<string>();
  const start = Math.min(state.since ?? 0, Math.floor(now / 1000) - 120);
  let cursor: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ per_page: String(ZENDESK_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    else params.set("start_time", String(Math.max(0, start)));
    const page = exportPage(await call(siteUrl, auth, `/api/v2/incremental/tickets/cursor.json?${params}`));
    if (!page) throw new ZendeskError("notFound", "No Zendesk answered at this address");
    for (const ticket of page.tickets) {
      const row = ticketRow(ticket, siteUrl);
      if (!row || seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      rows.push(row);
    }
    if (page.end || !page.cursor || seenCursors.has(page.cursor) || !page.tickets.length || rows.length >= ZENDESK_PER_RUN) break;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  const newest = rows.reduce((max, row) => Math.max(max, row.updated ? Math.floor(Date.parse(row.updated) / 1000) : 0), state.since ?? 0);
  const ids = [...new Set(rows.flatMap((r) => [...(r.requesterId ? [r.requesterId] : []), ...(r.assigneeId ? [r.assigneeId] : [])]))];
  const users = await fetchUsers(siteUrl, auth, ids);
  return { rows, users, next: parseZendeskQuery({ since: newest || null, total: state.total }) };
}

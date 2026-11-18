import {
  isSalesforceLimit,
  queryPage,
  recordRow,
  salesforceErrorMessage,
  SALESFORCE_API_VERSION,
  SALESFORCE_PER_RUN,
  soqlOf,
  type SalesforceQuery,
  type SalesforceRow,
} from "@/lib/salesforce-sync";
import type { JiraErrorCode } from "@/lib/jira-sync";
import { checkConnectionUrl, ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { answerJson, JiraError } from "@/server/jira-sync/client";
import { syncFetchReach } from "@/server/sync-reach";

/**
 * Leafdesk's calls to a Salesforce org's REST API (lib/salesforce-sync), signed in as a connected
 * app with the OAuth client credentials flow: the consumer key and secret are traded for an access
 * token at the org's My Domain (`/services/oauth2/token`), which acts as the user the app runs as.
 * A token is fetched for each run (it is never kept). Every call goes to the address the sync was
 * set up with, through the connections' fetch (https to a public address only, unless the host is
 * in CONNECTOR_ALLOWED_HOSTS): the `instance_url` of the token answer is not followed. An error is
 * a JiraError with a code; it never carries the answer's body or headers.
 */

export type SalesforceAuth = { clientId: string; clientSecret: string };

export class SalesforceError extends JiraError {
  constructor(code: JiraErrorCode, message: string = code, detail: string | null = null) {
    super(code, message, detail);
  }
}

const TIMEOUT_MS = 30_000;
/** The biggest answer read from Salesforce, in bytes (a page is at most 2000 records). */
const MAX_ANSWER_BYTES = 30_000_000;

/** Checks an org's address before anything is sent there. */
export function checkSalesforceSite(siteUrl: string) {
  try {
    checkConnectionUrl(siteUrl, syncFetchReach());
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new SalesforceError("invalidSite", error.message);
    throw error;
  }
}

async function send(siteUrl: string, path: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  checkSalesforceSite(siteUrl);
  let response: Response;
  try {
    response = await connectionFetch(new URL(path, siteUrl), { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }, syncFetchReach());
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new SalesforceError("invalidSite", error.message);
    throw new SalesforceError("unreachable", "Salesforce could not be reached");
  }
  return { response, body: await answerJson(response, MAX_ANSWER_BYTES) };
}

/** An access token for the connected app, or a SalesforceError saying why not. */
export async function salesforceToken(siteUrl: string, auth: SalesforceAuth): Promise<string> {
  const { response, body } = await send(siteUrl, "/services/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: auth.clientSecret }).toString(),
  });
  const answer = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (response.ok) {
    if (typeof answer?.access_token !== "string" || !answer.access_token) throw new SalesforceError("notFound", "No Salesforce answered at this address");
    return answer.access_token;
  }
  if (response.status === 404) throw new SalesforceError("notFound", "No Salesforce answered at this address");
  if (response.status === 429 || response.status >= 500) throw new SalesforceError("unreachable", `Salesforce answered ${response.status}`);
  const code = typeof answer?.error === "string" ? answer.error : "";
  if (code === "invalid_client" || code === "invalid_client_id") throw new SalesforceError("unauthorized", "Salesforce refused the consumer key and secret");
  // The app doesn't allow the flow, or names no user to run as.
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new SalesforceError("forbidden", "Salesforce doesn't let this app sign in this way", salesforceErrorMessage(body));
  }
  throw new SalesforceError("failed", `Salesforce answered ${response.status}`);
}

async function call(siteUrl: string, token: string, path: string): Promise<unknown> {
  const { response, body } = await send(siteUrl, path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (response.ok) {
    if (body === undefined) throw new SalesforceError("notFound", "No Salesforce answered at this address");
    return body;
  }
  if (isSalesforceLimit(body) || response.status === 429 || response.status >= 500) {
    throw new SalesforceError("unreachable", `Salesforce answered ${response.status}`);
  }
  if (response.status === 401) throw new SalesforceError("unauthorized", "Salesforce refused the access token");
  if (response.status === 403) throw new SalesforceError("forbidden", "The user the app runs as may not read this object", salesforceErrorMessage(body));
  if (response.status === 404) throw new SalesforceError("notFound", "No Salesforce answered at this address");
  if (response.status === 400) throw new SalesforceError("badQuery", "Salesforce refused the query", salesforceErrorMessage(body));
  throw new SalesforceError("failed", `Salesforce answered ${response.status}`);
}

/**
 * The records changed since the sync's newest change (oldest first), and what to remember for the
 * next run. Follows the query's pages up to SALESFORCE_PER_RUN records (the rest comes next run);
 * stops at its last page, a page address that comes back or a missing one.
 */
export async function fetchRecords(
  siteUrl: string,
  auth: SalesforceAuth,
  state: SalesforceQuery,
): Promise<{ rows: SalesforceRow[]; next: SalesforceQuery }> {
  const token = await salesforceToken(siteUrl, auth);
  const rows: SalesforceRow[] = [];
  const seenIds = new Set<string>();
  const seenPages = new Set<string>();
  let path: string | null = `/services/data/${SALESFORCE_API_VERSION}/query?${new URLSearchParams({ q: soqlOf(state) })}`;
  while (path) {
    const page = queryPage(await call(siteUrl, token, path));
    if (!page) throw new SalesforceError("notFound", "No Salesforce answered at this address");
    for (const item of page.records) {
      const row = recordRow(item, state.object);
      if (!row || seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      rows.push(row);
    }
    // A page address is the org's own path; one pointing elsewhere is not followed.
    const next: string | null = page.next && page.next.startsWith("/services/data/") && !seenPages.has(page.next) ? page.next : null;
    if (!next || !page.records.length || rows.length >= SALESFORCE_PER_RUN) break;
    seenPages.add(next);
    path = next;
  }
  const newest = rows.reduce<string | null>((max, row) => (row.modified && (!max || row.modified > max) ? row.modified : max), state.since);
  return { rows, next: { object: state.object, since: newest, total: state.total } };
}

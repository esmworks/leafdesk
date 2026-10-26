import {
  JIRA_FIELDS,
  JIRA_PAGE_SIZE,
  jiraErrorMessage,
  MAX_JIRA_ISSUES,
  projectsOf,
  searchPage,
  type JiraErrorCode,
  type JiraProject,
} from "@/lib/jira-sync";
import { checkConnectionUrl, ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { BodyTooLargeError, readBodyLimited } from "@/server/request-body";

/**
 * Leafdesk's calls to Jira Cloud's REST API (v3), signed in with an email address and API token
 * (Basic auth). They go through the connections' fetch: https to a public address only, unless the
 * host is in CONNECTOR_ALLOWED_HOSTS. An error says what went wrong in a code (and, for a refused
 * query, Jira's own words); it never carries the answer's body or headers.
 */

export type JiraAuth = { email: string; token: string };

export class JiraError extends Error {
  constructor(
    readonly code: JiraErrorCode,
    message: string = code,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;
/** The biggest answer read from Jira, in bytes (a page of issues with the fields a sync asks for is far smaller). */
const MAX_ANSWER_BYTES = 10_000_000;

/**
 * An answer's JSON, read up to `maxBytes` (readBodyLimited, so a site can't fill the server's
 * memory): undefined when it isn't JSON or stops coming, a JiraError "failed" when it is bigger.
 * Shared with GitHub's calls.
 */
export async function answerJson(response: Response, maxBytes: number): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readBodyLimited(response, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new JiraError("failed", "The answer is too big");
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Checks a site's address before anything is sent there. */
export function checkJiraSite(siteUrl: string) {
  try {
    checkConnectionUrl(siteUrl);
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new JiraError("invalidSite", error.message);
    throw error;
  }
}

async function call(siteUrl: string, auth: JiraAuth, path: string): Promise<unknown> {
  checkJiraSite(siteUrl);
  let response: Response;
  try {
    response = await connectionFetch(new URL(path, siteUrl), {
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new JiraError("invalidSite", error.message);
    throw new JiraError("unreachable", "Jira could not be reached");
  }
  const body = await answerJson(response, MAX_ANSWER_BYTES);
  if (response.ok) {
    // Something answered that isn't Jira's API (a sign-in page, another app).
    if (body === undefined) throw new JiraError("notFound", "No Jira answered at this address");
    return body;
  }
  if (response.status === 401) throw new JiraError("unauthorized", "Jira refused the email address and API token");
  if (response.status === 403) throw new JiraError("forbidden", "Jira doesn't let this account search there");
  if (response.status === 404) throw new JiraError("notFound", "No Jira answered at this address");
  if (response.status === 400) throw new JiraError("badQuery", "Jira refused the query", jiraErrorMessage(body));
  if (response.status === 429 || response.status >= 500) throw new JiraError("unreachable", `Jira answered ${response.status}`);
  throw new JiraError("failed", `Jira answered ${response.status}`);
}

/** The signed-in person's name: checks the address, email and token. */
export async function jiraAccount(siteUrl: string, auth: JiraAuth): Promise<{ name: string }> {
  const body = (await call(siteUrl, auth, "/rest/api/3/myself")) as Record<string, unknown> | null;
  const name = typeof body?.displayName === "string" ? body.displayName : "";
  if (!body || typeof body !== "object" || typeof body.accountId !== "string") {
    throw new JiraError("notFound", "No Jira answered at this address");
  }
  return { name: name || auth.email };
}

/** The projects the signed-in person can browse, by name (the first hundred). */
export async function jiraProjects(siteUrl: string, auth: JiraAuth): Promise<JiraProject[]> {
  return projectsOf(await call(siteUrl, auth, "/rest/api/3/project/search?maxResults=100&orderBy=name"));
}

/**
 * Every issue the JQL finds, with the fields a sync writes. Stops at the last page, a page that
 * comes back again (Jira has been seen to chain tokens endlessly) or a missing token; a query
 * finding more than MAX_JIRA_ISSUES is refused rather than half-synced.
 */
export async function searchIssues(siteUrl: string, auth: JiraAuth, jql: string): Promise<unknown[]> {
  const issues: unknown[] = [];
  const seenTokens = new Set<string>();
  const seenIds = new Set<string>();
  let token: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ jql, maxResults: String(JIRA_PAGE_SIZE), fields: JIRA_FIELDS.join(",") });
    if (token) params.set("nextPageToken", token);
    const page = searchPage(await call(siteUrl, auth, `/rest/api/3/search/jql?${params}`));
    if (!page) throw new JiraError("notFound", "No Jira answered at this address");
    let fresh = 0;
    for (const issue of page.issues) {
      const id = String((issue as { id?: unknown })?.id ?? (issue as { key?: unknown })?.key ?? "");
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      issues.push(issue);
      fresh++;
    }
    if (issues.length > MAX_JIRA_ISSUES) throw new JiraError("tooManyIssues", `The query finds more than ${MAX_JIRA_ISSUES} issues`);
    if (!page.next || !fresh || seenTokens.has(page.next)) return issues;
    seenTokens.add(page.next);
    token = page.next;
  }
}

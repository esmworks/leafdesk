import { GITHUB_PAGE_SIZE, MAX_GITHUB_PULLS, pullRow, type GithubErrorCode, type GithubPullRow, type GithubPullsQuery } from "@/lib/github-pulls-sync";
import { checkConnectionUrl, ConnectionFetchError, connectionFetch } from "@/server/connections/fetch";
import { JiraError } from "@/server/jira-sync/client";

/**
 * Leafdesk's calls to GitHub's REST API for synced pull requests (lib/github-pulls-sync), with a
 * token when the sync has one. They go through the connections' fetch like Jira's: https to a
 * public address only, unless the host is in CONNECTOR_ALLOWED_HOSTS. An error is a JiraError (the
 * runs record both alike) with a code; it never carries the answer's body or headers.
 */

export class GithubPullsError extends JiraError {
  constructor(code: GithubErrorCode, message: string = code) {
    super(code, message);
  }
}

const TIMEOUT_MS = 30_000;

/** Checks an API address before anything is sent there. */
export function checkGithubApi(apiUrl: string) {
  try {
    checkConnectionUrl(apiUrl);
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new GithubPullsError("invalidSite", error.message);
    throw error;
  }
}

async function call(apiUrl: string, token: string | null, path: string): Promise<unknown> {
  checkGithubApi(apiUrl);
  let response: Response;
  try {
    response = await connectionFetch(`${apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Leafdesk",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new GithubPullsError("invalidSite", error.message);
    throw new GithubPullsError("unreachable", "GitHub could not be reached");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    if (body === undefined) throw new GithubPullsError("notFound", "No GitHub answered at this address");
    return body;
  }
  // A spent rate limit passes: the next run tries again.
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new GithubPullsError("unreachable", "GitHub's rate limit is spent");
  }
  if (response.status === 401) throw new GithubPullsError("unauthorized", "GitHub refused the token");
  if (response.status === 403) throw new GithubPullsError("forbidden", "The token may not read this repository's pull requests");
  if (response.status === 404) throw new GithubPullsError("notFound", "No such repository, or the token doesn't reach it");
  if (response.status >= 500) throw new GithubPullsError("unreachable", `GitHub answered ${response.status}`);
  throw new GithubPullsError("failed", `GitHub answered ${response.status}`);
}

/** The repository as GitHub names it ("owner/name"): checks the address, the repository and the token. */
export async function githubRepository(apiUrl: string, repo: string, token: string | null): Promise<{ fullName: string }> {
  const body = (await call(apiUrl, token, `/repos/${repo}`)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || typeof body.full_name !== "string") {
    throw new GithubPullsError("notFound", "No GitHub answered at this address");
  }
  return { fullName: body.full_name };
}

/** Up to `max` pull requests in a state, the most recently updated first. */
async function listPulls(apiUrl: string, repo: string, token: string | null, state: "open" | "closed" | "all", max: number) {
  const rows: GithubPullRow[] = [];
  const seen = new Set<number>();
  for (let page = 1; rows.length < max; page++) {
    const params = new URLSearchParams({ state, sort: "updated", direction: "desc", per_page: String(GITHUB_PAGE_SIZE), page: String(page) });
    const body = await call(apiUrl, token, `/repos/${repo}/pulls?${params}`);
    if (!Array.isArray(body)) throw new GithubPullsError("notFound", "No GitHub answered at this address");
    for (const pull of body) {
      const row = pullRow(pull);
      // A pull request updated while the pages are read can come twice.
      if (!row || seen.has(row.number)) continue;
      seen.add(row.number);
      rows.push(row);
    }
    if (body.length < GITHUB_PAGE_SIZE) break;
  }
  return rows.slice(0, max);
}

/**
 * What a run writes: the pull requests the sync takes (`rows`, the MAX_GITHUB_PULLS most recently
 * updated) and, for a sync of open ones, the last closed ones (`closed`), which only finish the rows
 * of pull requests that were open before.
 */
export async function fetchPulls(apiUrl: string, query: GithubPullsQuery, token: string | null) {
  const rows = await listPulls(apiUrl, query.repo, token, query.state, MAX_GITHUB_PULLS);
  const closed = query.state === "open" ? await listPulls(apiUrl, query.repo, token, "closed", GITHUB_PAGE_SIZE) : [];
  return { rows, closed };
}

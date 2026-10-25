import type { JiraSyncError } from "./jira-sync";
import type { StatusGroup } from "./property-types";

/**
 * Keeping a database in step with a GitHub repository's pull requests, one way (server/github-pulls
 * for setting it up, server/jira-sync/run for the runs, which every synced database shares): each
 * pull request is a row, found again by its number. Pure, shared by the server, the import dialog
 * and the sync's dialog on the database.
 *
 * Pull requests come from GitHub's REST API (`GET /repos/{owner}/{repo}/pulls`, most recently
 * updated first), with a token when the repository is private. A row's title is the pull request's
 * title; the other fields go to the properties the sync made (GithubPullsMapping), written over on
 * each run. Not to be confused with server/github-sync, where pull requests move existing tasks.
 */

/** Where GitHub's REST API is; a GitHub Enterprise Server has its own (`https://host/api/v3`). */
export const GITHUB_API_URL = "https://api.github.com";
/** Where someone makes a token on github.com (one with read access to pull requests is enough). */
export const GITHUB_TOKENS_URL = "https://github.com/settings/personal-access-tokens/new";
/** Pull requests fetched per request (GitHub's ceiling). */
export const GITHUB_PAGE_SIZE = 100;
/** Pull requests a run takes at most, the most recently updated: older rows stay as they are. */
export const MAX_GITHUB_PULLS = 1000;

/** Which pull requests a sync takes: the open ones (and the last closed ones, to finish their rows), or all. */
export const GITHUB_PULL_STATES = ["open", "all"] as const;
export type GithubPullsState = (typeof GITHUB_PULL_STATES)[number];

export type GithubPullsQuery = { repo: string; state: GithubPullsState };

/** A pull request's stage, as the status property shows it. */
export const PULL_STAGES = ["draft", "open", "merged", "closed"] as const;
export type PullStage = (typeof PULL_STAGES)[number];
export const PULL_STAGE_GROUPS: Record<PullStage, StatusGroup> = { draft: "todo", open: "in_progress", merged: "done", closed: "done" };

/**
 * The properties a sync writes, by what each holds (their ids in the database), and the names of
 * the status options each stage goes to.
 */
export type GithubPullsMapping = {
  number: string;
  state?: string;
  author?: string;
  /** Text: the author's login when no one in the workspace is them. */
  authorOthers?: string;
  assignees?: string;
  /** Text: the logins of assignees the workspace doesn't have. */
  assigneesOthers?: string;
  labels?: string;
  branch?: string;
  base?: string;
  created?: string;
  merged?: string;
  link?: string;
  /** The status option each stage writes, by name (made in the language of whoever set it up). */
  stages: Record<PullStage, string>;
};
export type GithubPullsField = Exclude<keyof GithubPullsMapping, "stages">;

/** Names of the properties, stages and view a new sync makes, in its maker's language. */
export type GithubPullsNames = {
  number: string;
  state: string;
  author: string;
  assignees: string;
  others: (column: string) => string;
  labels: string;
  branch: string;
  base: string;
  created: string;
  merged: string;
  link: string;
  board: string;
  stages: Record<PullStage, string>;
};

export const ENGLISH_GITHUB_NAMES: GithubPullsNames = {
  number: "Number",
  state: "State",
  author: "Author",
  assignees: "Assignees",
  others: (column) => `${column} (others)`,
  labels: "Labels",
  branch: "Branch",
  base: "Base branch",
  created: "Created",
  merged: "Merged",
  link: "GitHub link",
  board: "Board",
  stages: { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" },
};

/**
 * Why a run didn't happen, in the codes Jira syncs use (`lastError` is one column): "unauthorized"
 * (GitHub refused the token), "forbidden" (the token may not read the repository's pull requests),
 * "notFound" (no such repository, or a private one the token doesn't reach), "unreachable" and
 * "failed" (passing: it tries again, a spent rate limit included), and "runAsGone", "accessLost",
 * "keyGone" as for Jira.
 */
export type GithubSyncError = Exclude<JiraSyncError, "badQuery" | "tooManyIssues">;

/** What setting up or changing a sync can be refused for, besides a run's errors (see JiraErrorCode). */
export type GithubErrorCode = GithubSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A sync as its dialog on the database shows it (never its token). */
export type GithubPullsSyncView = {
  apiUrl: string;
  repo: string;
  state: GithubPullsState;
  /** It signs in with a token (private repositories, a higher rate limit). */
  hasToken: boolean;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: GithubSyncError | null;
  /** Full access to the database: may change it, sync it or stop it. */
  canManage: boolean;
};

/** A GitHub account as a pull request names it. */
export type GithubUser = { id: string; login: string };

/** One pull request as a row: what the sync writes, before it is matched to the database's properties. */
export type GithubPullRow = {
  number: number;
  title: string;
  stage: PullStage;
  author: GithubUser | null;
  assignees: GithubUser[];
  labels: string[];
  branch: string | null;
  base: string | null;
  /** ISO timestamps. */
  created: string | null;
  merged: string | null;
  link: string | null;
};

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * A repository as "owner/name" from what someone typed: "owner/name", or its address on GitHub
 * ("https://github.com/owner/name/pulls"). Null when it can't be one.
 */
export function githubRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\.git$/, "");
  const address = /^(?:https?:\/\/)?[^/\s]+\.[^/\s]+\/([^/\s]+\/[^/\s]+)/i.exec(text);
  if (address && /^(?:https?:\/\/|[a-z0-9.-]*github)/i.test(text)) text = address[1];
  text = text.replace(/\/+$/, "");
  return REPO.test(text) && !text.endsWith("/.") && !text.endsWith("/..") ? text : null;
}

/**
 * A GitHub Enterprise Server's API address from what someone typed ("ghe.acme.com",
 * "https://ghe.acme.com/api/v3"): its origin with `/api/v3`, or GITHUB_API_URL for github.com and
 * for nothing typed. Null when it isn't an address.
 */
export function githubApiUrl(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return GITHUB_API_URL;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > 300 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  if (url.hostname === "github.com" || url.hostname === "api.github.com") return GITHUB_API_URL;
  return `${url.origin}/api/v3`;
}

/** A query from submitted or stored JSON, or null when it isn't a usable one. */
export function parseGithubQuery(value: unknown): GithubPullsQuery | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const repo = githubRepo(input.repo);
  const state = input.state === undefined ? "open" : input.state;
  if (!repo || !GITHUB_PULL_STATES.includes(state as GithubPullsState)) return null;
  return { repo, state: state as GithubPullsState };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function userOf(value: unknown): GithubUser | null {
  const user = record(value);
  const login = text(user?.login);
  const id = typeof user?.id === "number" || typeof user?.id === "string" ? String(user.id) : null;
  return login && id ? { id, login } : null;
}

const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

/** A web address GitHub gave, kept only when it is one. */
function link(value: unknown) {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** One pull request of a list page as a row, or null when it has no number. */
export function pullRow(value: unknown): GithubPullRow | null {
  const pull = record(value);
  const number = pull?.number;
  if (!pull || typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  const merged = time(pull.merged_at);
  const stage: PullStage = merged ? "merged" : pull.state === "closed" ? "closed" : pull.draft === true ? "draft" : "open";
  const assignees = (Array.isArray(pull.assignees) ? pull.assignees : []).map(userOf).filter((u): u is GithubUser => u !== null);
  const labels = (Array.isArray(pull.labels) ? pull.labels : []).map((l) => text(record(l)?.name)).filter((l): l is string => l !== null);
  return {
    number,
    title: (text(pull.title) ?? `#${number}`).slice(0, 2000),
    stage,
    author: userOf(pull.user),
    assignees: [...new Map(assignees.map((a) => [a.id, a])).values()],
    labels: [...new Set(labels)],
    branch: text(record(pull.head)?.ref),
    base: text(record(pull.base)?.ref),
    created: time(pull.created_at),
    merged,
    link: link(pull.html_url),
  };
}

/** The labels a run needs as options of the multi-select, in first-seen order. */
export function labelsNeeded(rows: GithubPullRow[]) {
  const seen = new Map<string, string>();
  for (const label of rows.flatMap((r) => r.labels)) if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  return [...seen.values()];
}

/**
 * The values a row gets from its pull request, keyed by property id, as normalizeRowProperties
 * takes them (option names, ids of people). Every mapped property gets a value, null to clear it.
 * `person` finds the workspace's person a GitHub account is (null for none).
 */
export function pullValues(row: GithubPullRow, mapping: Partial<GithubPullsMapping>, person: (user: GithubUser) => string | null) {
  const values: Record<string, unknown> = {};
  const set = (field: GithubPullsField, value: unknown) => {
    const id = mapping[field];
    if (id) values[id] = value;
  };
  set("number", row.number);
  set("state", mapping.stages?.[row.stage] ?? null);
  const author = row.author ? person(row.author) : null;
  set("author", author ? [author] : null);
  // Someone the workspace doesn't have goes in the text beside; without that text, nowhere.
  set("authorOthers", row.author && !(author && mapping.author) ? row.author.login : null);
  const assigned = row.assignees.map((a) => ({ login: a.login, id: person(a) }));
  const people = [...new Set(assigned.flatMap((a) => (a.id ? [a.id] : [])))];
  set("assignees", people.length ? people : null);
  const others = assigned.filter((a) => !(a.id && mapping.assignees)).map((a) => a.login);
  set("assigneesOthers", others.length ? others.join(", ") : null);
  set("labels", row.labels.length ? row.labels : null);
  set("branch", row.branch);
  set("base", row.base);
  set("created", row.created);
  set("merged", row.merged);
  set("link", row.link);
  return values;
}

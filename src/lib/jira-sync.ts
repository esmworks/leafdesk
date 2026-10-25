import type { StatusGroup } from "./property-types";

/**
 * Keeping a database in step with a Jira Cloud project or JQL query, one way (server/jira-sync for
 * the runs): each issue is a row, found again by its key. Pure, shared by the server, the import
 * dialog and the sync's dialog on the database.
 *
 * Issues come from Jira's REST API (`GET /rest/api/3/search/jql`, paged with `nextPageToken`),
 * signed in with an email address and an API token. A row's title is the issue's summary; the
 * other fields go to the properties the sync made (JiraMapping), and are written over on each run.
 */

/** The issue fields a run asks Jira for. */
export const JIRA_FIELDS = ["summary", "status", "assignee", "reporter", "priority", "labels", "duedate", "issuetype"] as const;

/** Issues fetched per request (Jira's ceiling when fields are asked for). */
export const JIRA_PAGE_SIZE = 100;
/** Issues a sync takes at most: a query matching more stops the run (narrow it). */
export const MAX_JIRA_ISSUES = 2000;
export const MAX_JQL_LENGTH = 2000;

/** How often a sync runs on its own, in minutes; 0 for only when someone asks. */
export const JIRA_INTERVALS = [15, 60, 360, 1440, 0] as const;
export type JiraInterval = (typeof JIRA_INTERVALS)[number];
export const DEFAULT_JIRA_INTERVAL: JiraInterval = 60;

/** What a sync takes from Jira: the issues of one project, or those a JQL query finds. */
export type JiraQuery = { project: string } | { jql: string };

/** The properties a sync writes, by what each holds: their ids in the database. */
export type JiraMapping = {
  key: string;
  status?: string;
  assignee?: string;
  /** Text: the assignee's name when no one in the workspace is them. */
  assigneeOthers?: string;
  /** Person: who reported the issue, found by email address like the assignee (none when not one of the workspace's). */
  reporter?: string;
  priority?: string;
  type?: string;
  labels?: string;
  due?: string;
  link?: string;
};
export type JiraField = keyof JiraMapping;

/** Names of the properties and view a new sync makes, in its maker's language. */
export type JiraNames = {
  key: string;
  status: string;
  assignee: string;
  reporter: string;
  others: (column: string) => string;
  priority: string;
  type: string;
  labels: string;
  due: string;
  link: string;
  board: string;
};

export const ENGLISH_JIRA_NAMES: JiraNames = {
  key: "Key",
  status: "Status",
  assignee: "Assignee",
  reporter: "Reporter",
  others: (column) => `${column} (others)`,
  priority: "Priority",
  type: "Type",
  labels: "Labels",
  due: "Due date",
  link: "Jira link",
  board: "Board",
};

/**
 * Why a run didn't happen: each but "unreachable" and "failed" (passing problems: it tries again
 * next time) pauses the sync until someone changes it or syncs by hand. "unauthorized": Jira
 * refused the email and token; "forbidden": they may not search there; "notFound": no Jira at the
 * address, or no such project; "badQuery": Jira refused the JQL; "tooManyIssues": the query finds
 * more than MAX_JIRA_ISSUES; "runAsGone" / "accessLost": whoever set it has no account, or can no
 * longer edit the database; "keyGone": the Key property was deleted or changed type.
 */
export const JIRA_SYNC_ERRORS = [
  "unauthorized",
  "forbidden",
  "notFound",
  "badQuery",
  "tooManyIssues",
  "unreachable",
  "runAsGone",
  "accessLost",
  "keyGone",
  "failed",
] as const;
export type JiraSyncError = (typeof JIRA_SYNC_ERRORS)[number];

export const pausesJiraSync = (error: JiraSyncError) => error !== "unreachable" && error !== "failed";

/**
 * What setting up or changing a sync can be refused for, besides a run's errors: "invalidSite" (not
 * an address Leafdesk may reach), "invalidInput" (a missing email or token, a bad project key or
 * query, an interval it doesn't offer), "alreadyRunning" (a run is going: try again shortly).
 */
export type JiraErrorCode = JiraSyncError | "invalidSite" | "invalidInput" | "alreadyRunning";

/** A sync as its dialog on the database shows it (never its token). */
export type JiraSyncView = {
  siteUrl: string;
  query: JiraQuery;
  email: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: JiraSyncError | null;
  lastErrorDetail: string | null;
  /** Full access to the database: may change it, sync it or stop it. */
  canManage: boolean;
  /** The person property issues' reporters go to; null when they go nowhere. */
  reporter: string | null;
  /** With full access: the database's person properties, which the reporter can go to. */
  personProperties: { id: string; name: string }[];
};

/** What every viewer of a synced database is told (the snapshot's `sync`). */
export type DatabaseSyncSummary = {
  source: "jira";
  siteUrl: string;
  lastRunAt: string | null;
  lastError: JiraSyncError | null;
  enabled: boolean;
};

/** A Jira Cloud project, as the project picker lists it. */
export type JiraProject = { key: string; name: string };

/** One issue as a row: what the sync writes, before it is matched to the database's properties. */
export type JiraRow = {
  key: string;
  title: string;
  status: { name: string; group: StatusGroup } | null;
  assignee: { name: string; email: string | null } | null;
  reporter: { name: string; email: string | null } | null;
  priority: string | null;
  type: string | null;
  labels: string[];
  /** "YYYY-MM-DD" */
  due: string | null;
  link: string;
};

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

/** A project key as Jira writes it (upper case), or null when it can't be one. */
export function projectKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return PROJECT_KEY.test(key) ? key.toUpperCase() : null;
}

/** A query from submitted or stored JSON, or null when it isn't a usable one. */
export function parseJiraQuery(value: unknown): JiraQuery | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.project !== undefined) {
    const key = projectKey(input.project);
    return key ? { project: key } : null;
  }
  if (typeof input.jql !== "string") return null;
  const jql = input.jql.trim();
  return jql && jql.length <= MAX_JQL_LENGTH ? { jql } : null;
}

/** The JQL a query runs: a project's issues by key, or the query as written. */
export function jqlOf(query: JiraQuery): string {
  return "project" in query ? `project = "${query.project}" ORDER BY key ASC` : query.jql;
}

/**
 * A Jira site's address from what someone typed ("acme.atlassian.net", "https://acme.atlassian.net/jira/…"):
 * its origin, https unless written as http (which only a host allowed for connections can use).
 * Null when it isn't an address.
 */
export function jiraSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.origin;
}

export const isJiraInterval = (value: unknown): value is JiraInterval => JIRA_INTERVALS.includes(value as JiraInterval);

/** An interval's text key (under `import.jira.intervals`). */
export const jiraIntervalKey = (minutes: number) => (minutes === 0 ? "manual" : (`m${minutes}` as `m${Exclude<JiraInterval, 0>}`));

/** Where people make an API token for their Atlassian account. */
export const ATLASSIAN_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** A status's stage from its Jira category ("new", "indeterminate", "done"). */
export function statusGroupOf(category: unknown): StatusGroup {
  if (category === "done") return "done";
  if (category === "indeterminate") return "in_progress";
  return "todo";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const nameOf = (value: unknown) => text(record(value)?.name);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One issue of a search page as a row, or null when it has no key. */
export function issueRow(issue: unknown, siteUrl: string): JiraRow | null {
  const item = record(issue);
  const key = text(item?.key);
  if (!item || !key) return null;
  const fields = record(item.fields) ?? {};
  const status = record(fields.status);
  const statusName = text(status?.name);
  const assignee = record(fields.assignee);
  const assigneeName = text(assignee?.displayName) ?? text(assignee?.emailAddress);
  const reporter = record(fields.reporter);
  const reporterName = text(reporter?.displayName) ?? text(reporter?.emailAddress);
  const labels = Array.isArray(fields.labels) ? fields.labels.map(text).filter((l): l is string => l !== null) : [];
  const due = typeof fields.duedate === "string" && DAY.test(fields.duedate) ? fields.duedate : null;
  return {
    key,
    title: (text(fields.summary) ?? key).slice(0, 2000),
    status: statusName ? { name: statusName, group: statusGroupOf(record(status?.statusCategory)?.key) } : null,
    assignee: assigneeName ? { name: assigneeName, email: text(assignee?.emailAddress) } : null,
    reporter: reporterName ? { name: reporterName, email: text(reporter?.emailAddress) } : null,
    priority: nameOf(fields.priority),
    type: nameOf(fields.issuetype),
    labels: [...new Set(labels)],
    due,
    link: `${siteUrl}/browse/${encodeURIComponent(key)}`,
  };
}

/** A page of `GET /rest/api/3/search/jql`: its issues, and the token of the next page (null on the last). */
export function searchPage(body: unknown): { issues: unknown[]; next: string | null } | null {
  const page = record(body);
  if (!page || !Array.isArray(page.issues)) return null;
  const next = page.isLast === true ? null : text(page.nextPageToken);
  return { issues: page.issues, next };
}

/** The projects of a page of `GET /rest/api/3/project/search`. */
export function projectsOf(body: unknown): JiraProject[] {
  const values = record(body)?.values;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const project = record(value);
    const key = projectKey(project?.key);
    return key ? [{ key, name: text(project?.name) ?? key }] : [];
  });
}

/** The first of Jira's error messages in an error answer (`errorMessages`, then `errors`), if any. */
export function jiraErrorMessage(body: unknown): string | null {
  const answer = record(body);
  if (!answer) return null;
  const messages = Array.isArray(answer.errorMessages) ? answer.errorMessages.map(text).filter(Boolean) : [];
  const fieldErrors = Object.values(record(answer.errors) ?? {}).map(text).filter(Boolean);
  const first = messages[0] ?? fieldErrors[0];
  return first ? first.slice(0, 300) : null;
}

/** Option names a run needs in a select, status or multi-select property, in first-seen order. */
export function optionsNeeded(rows: JiraRow[]) {
  const status = new Map<string, { name: string; group: StatusGroup }>();
  for (const row of rows) {
    if (row.status && !status.has(row.status.name.toLowerCase())) status.set(row.status.name.toLowerCase(), row.status);
  }
  return {
    status: [...status.values()],
    priority: distinct(rows.flatMap((r) => (r.priority ? [r.priority] : []))),
    type: distinct(rows.flatMap((r) => (r.type ? [r.type] : []))),
    labels: distinct(rows.flatMap((r) => r.labels)),
  };
}

function distinct(values: string[]) {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
}

/**
 * The values a row gets from its issue, keyed by property id, as normalizeRowProperties takes them
 * (option names, a day, ids of people). Every mapped property gets a value, null to clear it: the
 * issue is the source. `person` finds the workspace's person an assignee or reporter is (null for none).
 */
export function rowValues(row: JiraRow, mapping: Partial<JiraMapping>, person: (assignee: { name: string; email: string | null }) => string | null) {
  const values: Record<string, unknown> = {};
  const set = (field: JiraField, value: unknown) => {
    const id = mapping[field];
    if (id) values[id] = value;
  };
  const assigned = row.assignee ? person(row.assignee) : null;
  set("key", row.key);
  set("status", row.status?.name ?? null);
  set("assignee", assigned ? [assigned] : null);
  // Someone the workspace doesn't have goes in the text beside; without that text, nowhere.
  set("assigneeOthers", row.assignee && !(assigned && mapping.assignee) ? row.assignee.name : null);
  const reporter = row.reporter ? person(row.reporter) : null;
  set("reporter", reporter ? [reporter] : null);
  set("priority", row.priority);
  set("type", row.type);
  set("labels", row.labels.length ? row.labels : null);
  set("due", row.due);
  set("link", row.link);
  return values;
}

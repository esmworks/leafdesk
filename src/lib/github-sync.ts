import { STATUS_GROUPS, type StatusGroup } from "./property-types";

/**
 * GitHub pull requests that move a database's rows (server/github-sync): a repository's or an
 * organization's webhook sends pull request events to the database's own address, signed with a
 * secret Leafdesk made. A pull request names rows by their unique IDs ("TASK-12", the database's
 * prefix only) in its title, its description or its branch's name; those rows get the pull
 * request's link and, as the setup says, a status for it being opened, merged or closed. Pure: for
 * the server and the setup dialog alike.
 */

/** What a database's GitHub setup writes, by property and option ids. */
export type GithubMapping = {
  /** A text property (every pull request's link, one a line) or url property (the latest one); null for none. */
  linkPropertyId: string | null;
  /** A status property the pull requests move rows in; null to leave statuses alone. */
  statusPropertyId: string | null;
  /** Its options for a pull request opened or ready for review, merged, and closed without merging; null leaves the row. */
  opened: string | null;
  merged: string | null;
  closed: string | null;
};

export const EMPTY_GITHUB_MAPPING: GithubMapping = { linkPropertyId: null, statusPropertyId: null, opened: null, merged: null, closed: null };

/** Rows one pull request may name; IDs past these are left out. */
export const MAX_GITHUB_ROWS = 20;
/** Deliveries a setup keeps to show, newest first. */
export const GITHUB_DELIVERIES_KEPT = 50;
/** Links a text property keeps, the latest ones. */
export const MAX_GITHUB_LINKS = 30;
/** A delivery's body at most (GitHub's pull request events are far smaller). */
export const MAX_GITHUB_BODY_BYTES = 2 * 1024 * 1024;
/** Deliveries a setup takes a minute at most. */
export const GITHUB_PER_MINUTE = 120;

/** Pull request actions that are handled: the rest (pushes to its branch, labels, reviews) are left alone. */
export const GITHUB_ACTIONS = ["opened", "reopened", "ready_for_review", "edited", "closed"] as const;

/** A pull request as a delivery describes it. */
export type PullRequest = {
  action: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  draft: boolean;
  merged: boolean;
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The pull request of a `pull_request` event's payload; null when it has none. */
export function pullRequestOf(payload: unknown): PullRequest | null {
  const body = record(payload);
  const pr = record(body.pull_request);
  const url = str(pr.html_url);
  const number = typeof pr.number === "number" ? pr.number : typeof body.number === "number" ? body.number : null;
  if (!/^https:\/\//.test(url) || number === null) return null;
  return {
    action: str(body.action),
    repo: str(record(body.repository).full_name),
    number,
    title: str(pr.title),
    body: str(pr.body),
    url,
    branch: str(record(pr.head).ref),
    draft: pr.draft === true,
    merged: pr.merged === true,
  };
}

/**
 * The ID numbers of rows `text` names with `prefix`: "TASK-12", "task-12", "[TASK-12]",
 * "feature/TASK-12-login". An ID stands apart from letters and digits on both sides ("TASK-123"
 * isn't "TASK-12", "XTASK-12" isn't one); other characters (/, _, -, brackets) may touch it.
 */
export function findIds(text: string, prefix: string): number[] {
  if (!prefix || !text) return [];
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}-(\\d{1,9})(?![A-Za-z0-9])`, "gi");
  const out: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The rows a pull request names, by ID number: from its title, then its description, then its branch; at most MAX_GITHUB_ROWS. */
export function pullRequestIds(pr: Pick<PullRequest, "title" | "body" | "branch">, prefix: string): number[] {
  const out: number[] = [];
  for (const text of [pr.title, pr.body, pr.branch]) {
    for (const n of findIds(text, prefix)) if (!out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_GITHUB_ROWS);
}

/** What a pull request event does to a row's status: opened (a draft only once it is ready for review), merged, closed; null for none. */
export function statusMove(pr: Pick<PullRequest, "action" | "draft" | "merged">): "opened" | "merged" | "closed" | null {
  switch (pr.action) {
    case "opened":
    case "reopened":
      return pr.draft ? null : "opened";
    case "ready_for_review":
      return "opened";
    case "closed":
      return pr.merged ? "merged" : "closed";
    default:
      return null;
  }
}

type StatusOption = { id: string; group?: StatusGroup };

/**
 * The status a row moves to, or null to leave it: the option the setup gives the move, unless the
 * row has it already. A row that is done (its status in the done group, or the "merged" option)
 * moves only for a merge: a pull request opened again, or another one opened or closed, doesn't
 * take a finished row back.
 */
export function nextStatus(current: unknown, move: "opened" | "merged" | "closed" | null, mapping: GithubMapping, options: StatusOption[]): string | null {
  if (!move) return null;
  const target = mapping[move];
  if (!target || !options.some((o) => o.id === target) || current === target) return null;
  const now = typeof current === "string" ? options.find((o) => o.id === current) : undefined;
  const done = now !== undefined && (now.id === mapping.merged || (now.group && STATUS_GROUPS.includes(now.group) ? now.group : "todo") === "done");
  if (done && move !== "merged") return null;
  return target;
}

/**
 * A link property's value with a pull request's link added, or null when it has it already: a
 * text property keeps every link, one a line (the latest MAX_GITHUB_LINKS); a url property the latest.
 */
export function withLink(value: unknown, url: string, type: "text" | "url"): string | null {
  if (type === "url") return value === url ? null : url;
  const lines = (typeof value === "string" ? value : "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(url)) return null;
  return [...lines, url].slice(-MAX_GITHUB_LINKS).join("\n");
}

/** How one row a delivery named went. */
export type GithubRowOutcome = "updated" | "unchanged" | "notFound" | "noAccess" | "failed";
export type GithubDeliveryRow = { id: string; outcome: GithubRowOutcome; error?: string };

/**
 * How a delivery went: `done` (its rows looked at), `ignored` (an event or action that isn't
 * handled; a ping), `failed` (it couldn't be handled at all, `error` says why), or still `received`.
 */
export type GithubDeliveryStatus = "received" | "done" | "ignored" | "failed";

/** Why a whole delivery couldn't be handled: no unique ID with a prefix, nobody to write as, they lost edit access, the database is in the trash. */
export type GithubDeliveryError = "noUniqueId" | "runAsGone" | "accessLost" | "inTrash" | "failed";

export type GithubDeliveryView = {
  id: string;
  at: string;
  /** "pull_request", "ping"… */
  event: string;
  action: string | null;
  status: GithubDeliveryStatus;
  pullRequest: { repo: string; number: number; title: string; url: string } | null;
  rows: GithubDeliveryRow[];
  error: GithubDeliveryError | null;
};

/** A database's GitHub setup as its dialog shows it. */
export type GithubSyncView = {
  /** The payload URL to give GitHub. */
  webhookUrl: string;
  /** The secret to give GitHub; null when the server can't open it any more (a new one replaces it). */
  secret: string | null;
  mapping: GithubMapping;
  /** Whom its writes are made as: whoever saved it last. */
  runAs: { id: string; name: string } | null;
  deliveries: GithubDeliveryView[];
};

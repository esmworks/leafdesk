import { STATUS_GROUPS, type StatusGroup } from "./property-types";

/**
 * Database automations: "when a row is added, or a property of a row changes (to a value), or a
 * date of a row is some days past, do these things". Types, the pure trigger matching and the
 * limits, for the server (server/automations) and the settings dialog alike.
 */

/** The date a "date passed" trigger counts from: a date property (by id), or when the row was added or last edited. */
export type DatePassedBasis = "created_time" | "last_edited_time" | (string & {});

/** Only rows whose status property is in one of these groups (a row without a status counts as to do). */
export type StatusCondition = { propertyId: string; groups: StatusGroup[] };

/** What starts an automation. */
export type AutomationTrigger =
  /** A row is added to the database, however (the app, a form, an import, MCP, the API). */
  | { type: "row_created" }
  /**
   * A row's value of `propertyId` changes; any property when it is null. With `to`, only when the
   * value becomes it: an option id (select, status), true or false (checkbox), or a user id or
   * option id that gets added (person, multi-select).
   */
  | { type: "property_changed"; propertyId: string | null; to?: string | boolean | null }
  /**
   * A row's date (`date`: a date property's start, or when the row was added or last edited) is at
   * least `days` days past, and its status is in `status` when set. Found by a periodic check
   * (server/automations/timed.ts), not by writes: each row starts it once per value of its date
   * (see automation_fire).
   */
  | DatePassedTrigger;

export type DatePassedTrigger = { type: "date_passed"; date: DatePassedBasis; days: number; status?: StatusCondition | null };

/**
 * A value an automation sets that is worked out when it runs: `now` is the day it runs (a date
 * property), `actor` whoever made the change that started it (a person property).
 */
export type AutomationDynamicValue = { $: "now" } | { $: "actor" };

/** What an automation does, in order. */
export type AutomationAction =
  /** Sets these values on the row, by property id (a stored value or an AutomationDynamicValue). */
  | { type: "set_properties"; values: Record<string, unknown> }
  /**
   * An inbox notification (and an email, as each of them chooses) to these people and to whoever
   * the row's person properties `propertyIds` name, as long as they can open the row.
   */
  | { type: "notify"; userIds: string[]; propertyIds: string[] }
  /** A signed JSON POST to this address (see signWebhook). */
  | { type: "webhook"; url: string }
  /**
   * Runs an agent (see lib/agents.ts) on the row, with this task: it's queued, and runs apart, as
   * the agent. Saving the automation shares the database with the agent (edit access).
   */
  | { type: "run_agent"; agentId: string; prompt: string }
  /** Moves the row to the trash (restorable, like any trashed row). Always the last action. */
  | { type: "move_to_trash" };

export type AutomationActionType = AutomationAction["type"];

export const AUTOMATION_ACTION_TYPES = [
  "set_properties",
  "notify",
  "webhook",
  "run_agent",
  "move_to_trash",
] as const satisfies AutomationActionType[];

/**
 * Why a list of actions can't be saved because of "move to trash": nothing can follow it (the row
 * is gone), it can't come twice, and an agent can't be given a row the same run trashes (it runs
 * apart, later). Null when the list is fine.
 */
export function trashProblem(actions: { type: AutomationActionType }[]): "trashNotLast" | "trashWithAgent" | null {
  const at = actions.findIndex((a) => a.type === "move_to_trash");
  if (at === -1) return null;
  if (at !== actions.length - 1) return "trashNotLast";
  if (actions.some((a) => a.type === "run_agent")) return "trashWithAgent";
  return null;
}

/** At most this many automations per database, and actions per automation. */
export const MAX_AUTOMATIONS = 50;
export const MAX_AUTOMATION_ACTIONS = 10;
export const MAX_NOTIFY_PEOPLE = 50;
export const MAX_AUTOMATION_NAME = 120;
export const MAX_WEBHOOK_URL = 2000;

/** Property types a "becomes" condition can name a value of. */
export const TO_VALUE_TYPES = ["select", "status", "checkbox", "person", "multi_select"] as const;

/** Property types an automation can't set (computed, or kept by the server). */
export const UNSETTABLE_TYPES = [
  "formula",
  "rollup",
  "created_by",
  "created_time",
  "last_edited_by",
  "last_edited_time",
] as const;

export function isDynamicValue(value: unknown): value is AutomationDynamicValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    ((value as { $?: unknown }).$ === "now" || (value as { $?: unknown }).$ === "actor")
  );
}

/** A row write an automation may react to. */
export type RowWrite = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The row is new: `before` is empty. */
  created: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Ids of the properties whose values differ between `before` and `after`. */
export function changedProperties(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !same(before[k], after[k]));
}

/** Whether `value` holds `to`: equals it, or for a list, contains it. Checkboxes are false unset. */
function holds(value: unknown, to: string | boolean) {
  if (typeof to === "boolean") return (value === true) === to;
  return Array.isArray(value) ? value.includes(to) : value === to;
}

/**
 * Whether a row write starts an automation with this trigger. A "becomes" condition matches
 * only when the value didn't hold it before, so saving the same value again does nothing; a new
 * row matches when it starts out with it.
 */
export function matchesTrigger(trigger: AutomationTrigger, write: RowWrite) {
  if (trigger.type === "row_created") return write.created;
  // Found by the periodic check, never by a write.
  if (trigger.type === "date_passed") return false;
  const changed = changedProperties(write.before, write.after);
  if (trigger.propertyId === null) return !write.created && changed.length > 0;
  if (!changed.includes(trigger.propertyId)) return false;
  // A new row's values weren't changed by anyone: only a "becomes" condition looks at them.
  if (trigger.to === undefined || trigger.to === null) return !write.created;
  return holds(write.after[trigger.propertyId], trigger.to) && !holds(write.before[trigger.propertyId], trigger.to);
}

// ------------------------------------------------------------------------------- date passed

/** A "date passed" trigger counts at most this many days. */
export const MAX_DATE_PASSED_DAYS = 3650;
/** Runs one "date passed" automation starts per check at most; the rest wait for the next ones. */
export const DATE_PASSED_BATCH = 100;

/**
 * How often "date passed" automations are checked: AUTOMATION_DATE_CHECK_SECONDS (`value`), 600
 * (ten minutes) when unset or invalid, at least 10.
 */
export function dateCheckIntervalMs(value: string | undefined) {
  const seconds = Number(value);
  return (value && Number.isFinite(seconds) && seconds > 0 ? Math.max(Math.round(seconds), 10) : 600) * 1000;
}

/**
 * The day and the instant a row's date must be at or before to be `days` days past at `now`:
 * dates that are days count by calendar day (`today`, the server's day), times and the row's
 * added/edited times by the clock. Both as text that compares in order with stored values (days
 * as YYYY-MM-DD, times as UTC ISO strings).
 */
export function datePassedCutoffs(days: number, now: Date, today: string) {
  const [y, m, d] = today.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
  return { day, instant: new Date(now.getTime() - days * 86_400_000).toISOString() };
}

/** The start of a stored date value (a day, or a UTC time), or null when it has none. */
export function dateStart(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const start = value.split("/")[0];
  return /^\d{4}-\d{2}-\d{2}($|T)/.test(start) ? start : null;
}

/** Whether a date's start (see dateStart; a time as a UTC ISO string) is at or before the cutoffs. */
export function startPassed(start: string, cutoffs: { day: string; instant: string }) {
  return start.length === 10 ? start <= cutoffs.day : start <= cutoffs.instant;
}

/**
 * The option ids of a status property whose rows meet a status condition, and whether rows
 * without a (known) status do: they count as to do.
 */
export function statusMatch(options: { id: string; group?: StatusGroup }[], groups: StatusGroup[]) {
  const groupOf = (o: { group?: StatusGroup }) => (o.group && STATUS_GROUPS.includes(o.group) ? o.group : "todo");
  return {
    optionIds: options.filter((o) => groups.includes(groupOf(o))).map((o) => o.id),
    knownIds: options.map((o) => o.id),
    empty: groups.includes("todo"),
  };
}

/** Whether a row's status value meets the condition (see statusMatch). */
export function statusMeets(value: unknown, match: ReturnType<typeof statusMatch>) {
  if (typeof value !== "string" || !match.knownIds.includes(value)) return match.empty;
  return match.optionIds.includes(value);
}

/**
 * Whether a row starts a "date passed" automation at this check: its date (`basis`, as the
 * check works it out) is past the cutoffs, its status meets the condition, and it hasn't already
 * started it for this value of its date (`fired`: the value it last started it for). A row edited
 * later, or given another date, starts it again once that one is past.
 */
export function datePassedFires(
  row: { basis: string | null; status?: unknown },
  trigger: { status?: StatusCondition | null },
  cutoffs: { day: string; instant: string },
  match: ReturnType<typeof statusMatch> | null,
  fired: string | null,
) {
  if (!row.basis || !startPassed(row.basis, cutoffs)) return false;
  if (trigger.status && match && !statusMeets(row.status, match)) return false;
  return fired !== row.basis;
}

/** The event name a webhook's body carries. */
export const webhookEvent = (created: boolean) => (created ? "row.created" : "row.updated");

/** The event of a run: a row added or changed, or a "date passed" run (it has the date it ran for). */
export const runEvent = (run: { created: boolean; basis: string | null }) => (run.basis !== null ? "row.date_passed" : webhookEvent(run.created));

/** Header names of a webhook request. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Leafdesk-Signature";
export const WEBHOOK_EVENT_HEADER = "X-Leafdesk-Event";
export const WEBHOOK_DELIVERY_HEADER = "X-Leafdesk-Delivery";

/** A webhook delivery is tried this many times before it counts as failed. */
export const MAX_WEBHOOK_ATTEMPTS = 5;

/** How long to wait before trying a webhook again after `attempts` failed tries. */
export function retryDelayMs(attempts: number) {
  const steps = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1];
}

/** Whether a failed delivery is worth trying again: network errors, timeouts, 408, 429 and 5xx. */
export function retriable(status: number | null) {
  return status === null || status === 408 || status === 429 || status >= 500;
}

/**
 * Why a "date passed" automation's last check couldn't look for rows: its date or status
 * property is deleted (it waits for a restore), or whoever saved it lost full access to the
 * database. Cleared by the next check that can, and by saving it.
 */
export type AutomationCheckError = "propertyDeleted" | "noAccess";

/** What a run is: waiting (or waiting to retry), running, done, or failed in some step. */
export const AUTOMATION_RUN_STATUSES = ["pending", "running", "done", "failed"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export type AutomationStepStatus = "pending" | "done" | "failed" | "skipped";

/**
 * One action of a run. `code` is a short machine-readable reason (`noAccess`, `blocked`,
 * `timeout`, `http`…); `status` the HTTP status a webhook answered with.
 */
export type AutomationStep = {
  type: AutomationActionType;
  status: AutomationStepStatus;
  attempts: number;
  code?: string;
  error?: string;
  httpStatus?: number;
  /** Notify: how many people were told. */
  notified?: number;
  /** Run an agent: the run it queued (see agent_run). */
  agentRunId?: string;
};

/** A run is done when every step is; failed when one failed for good; else it still waits. */
export function runStatusOf(steps: AutomationStep[]): AutomationRunStatus {
  if (steps.some((s) => s.status === "pending")) return "pending";
  return steps.some((s) => s.status === "failed") ? "failed" : "done";
}

/** Text the signature covers: the timestamp (Unix seconds), a dot, and the raw body. */
export const signedContent = (timestamp: number, body: string) => `${timestamp}.${body}`;

/** The signature header's value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of signedContent>`. */
export const signatureHeader = (timestamp: number, hexSignature: string) => `t=${timestamp},v1=${hexSignature}`;

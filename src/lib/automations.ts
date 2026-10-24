import type { FilterCombinator, FilterEntry, SortRule } from "@/db/schema/app";
import type { AutomationSchedule } from "./automation-schedule";
import { STATUS_GROUPS, type StatusGroup } from "./property-types";
import { dayString, localDay } from "./time-zone";

/**
 * Database automations: "when a row is added, a property of a row changes (to a value), a date of
 * a row is some days past, a schedule comes round or a request arrives at the automation's own
 * address, do these steps". Types, the pure trigger matching and the limits, for the server
 * (server/automations) and the settings dialog alike.
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
   * A row's value of `propertyId` changes; any property when it is null. `propertyIds`, when it
   * names more than one, watches all of them (`propertyId` is then the first). With `to` (one
   * property only), only when the value becomes it: an option id (select, status), true or false
   * (checkbox), or a user id or option id that gets added (person, multi-select).
   */
  | { type: "property_changed"; propertyId: string | null; propertyIds?: string[]; to?: string | boolean | null }
  /**
   * A row's date (`date`: a date property's start, or when the row was added or last edited) is at
   * least `days` days past, and its status is in `status` when set. Found by a periodic check
   * (server/automations/timed.ts), not by writes: each row starts it once per value of its date
   * (see automation_fire).
   */
  | DatePassedTrigger
  /**
   * A schedule comes round, in the automation's time zone (see lib/automation-schedule). A run
   * has no row: steps that act on one need a "for each" over found rows.
   */
  | { type: "schedule"; schedule: AutomationSchedule }
  /**
   * A POST arrives at the automation's secret address (server/automations/incoming.ts): its JSON
   * body is the run's `trigger`. `example` is a body to offer in the editor's variable picker and
   * test runs. A run has no row.
   */
  | { type: "incoming_webhook"; example?: unknown };

export type AutomationTriggerType = AutomationTrigger["type"];
export const AUTOMATION_TRIGGER_TYPES = [
  "row_created",
  "property_changed",
  "date_passed",
  "schedule",
  "incoming_webhook",
] as const satisfies AutomationTriggerType[];

/** Whether runs of a trigger are about a row (the `trigger` of their templates is that row). */
export const hasRow = (trigger: { type: AutomationTriggerType }) =>
  trigger.type === "row_created" || trigger.type === "property_changed" || trigger.type === "date_passed";

/** The properties a property_changed trigger watches; empty for any property. */
export const watchedProperties = (trigger: Extract<AutomationTrigger, { type: "property_changed" }>) =>
  trigger.propertyIds?.length ? trigger.propertyIds : trigger.propertyId ? [trigger.propertyId] : [];

export type DatePassedTrigger = { type: "date_passed"; date: DatePassedBasis; days: number; status?: StatusCondition | null };

/**
 * A value an automation sets that is worked out when it runs: `now` is the day it runs (a date
 * property), `actor` whoever made the change that started it (a person property).
 */
export type AutomationDynamicValue = { $: "now" } | { $: "actor" };

/**
 * A step's id: what later steps' templates call its output by (`{{find.rows}}`). Saved steps
 * always have one; steps saved before ids existed are given `step<n>` by position (stepIds).
 */
export const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** HTTP methods an HTTP request step may use. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Values set on a row by property id: stored values, AutomationDynamicValues or text with templates. */
export type StepValues = Record<string, unknown>;

/**
 * What an automation does, in order. Each step may have an `id` (see STEP_ID). Text in a step can
 * hold templates (lib/automation-templates). Steps that act on a row act on the run's row, or with
 * `forEach` (a find_rows step's id) on each row that step found, one after another.
 */
export type AutomationAction = (
  /** Sets these values on the row, by property id (a stored value or an AutomationDynamicValue). */
  | { type: "set_properties"; values: StepValues; forEach?: string }
  /**
   * An inbox notification (and an email, as each of them chooses) to these people and to whoever
   * the row's person properties `propertyIds` name, as long as they can open the row (the
   * database, for a run without one), with an optional message.
   */
  | { type: "notify"; userIds: string[]; propertyIds: string[]; message?: string; forEach?: string }
  /** A signed JSON POST of the row to this address (see signWebhook). */
  | { type: "webhook"; url: string }
  /**
   * Runs an agent (see lib/agents.ts) on the row, with this task: it's queued, and runs apart, as
   * the agent. Saving the automation shares the database with the agent (edit access).
   */
  | { type: "run_agent"; agentId: string; prompt: string; forEach?: string }
  /** Moves the row to the trash (restorable, like any trashed row). Always the last action. */
  | { type: "move_to_trash" }
  /**
   * An HTTP request (server/automations/http.ts). `body` is JSON, sent for every method but GET
   * and DELETE when given; its strings may be templates.
   */
  | { type: "http_request"; method: HttpMethod; url: string; headers: { name: string; value: string }[]; body?: unknown }
  /** Rows of a database the automation's person can open, by a view's filters and sorts. */
  | {
      type: "find_rows";
      databaseId: string;
      filters?: FilterEntry[];
      filterCombinator?: FilterCombinator;
      sorts?: SortRule[];
      limit: number;
    }
  /** Adds a row to a database (this one or another), with these values (property ids). */
  | { type: "create_row"; databaseId: string; title?: string; values: StepValues }
  /**
   * Changes the first row of a database whose `matchPropertyId` ("title" for the row's title)
   * equals `matchValue`, or adds one with it when there is none.
   */
  | { type: "upsert_row"; databaseId: string; matchPropertyId: string; matchValue: string; title?: string; values: StepValues }
  /** Waits this many minutes before the next step (the run waits in the queue, not in memory). */
  | { type: "wait"; minutes: number }
  /** Writes a message into the run's history. */
  | { type: "log"; message: string }
  /**
   * Confetti in the app for whoever made the change that started the run, in each of their open
   * windows (lib/celebrate-event). A run nobody started (a schedule, a date, an incoming webhook)
   * or one that comes too late (CELEBRATE_WITHIN_MS) skips it.
   */
  | { type: "celebrate" }
  /**
   * Starts a follow-up sequence of the database (lib/sequences.ts) on the row, sending from the
   * automation's person's mailbox. A row in it already is skipped.
   */
  | { type: "start_sequence"; sequenceId: string; forEach?: string }
  /**
   * Asks these people, and whoever the row's person properties `propertyIds` name, to approve the
   * run going on (server/automations/approval.ts): it waits in the "For review" queue, with
   * `message`, for one of them. Approved, the next step runs; rejected, the run stops. Unanswered
   * after `timeoutDays`, it stops or (`onTimeout: "continue"`) goes on.
   */
  | ApprovalAction
  /**
   * Posts `message` (text with templates, in Slack's markup) to a Slack incoming webhook, with the
   * row (or the database, for a run without one) as a link (lib/slack). The address is a secret:
   * `sealed` (server/secret-box) is kept with the step and never leaves the server; `hint` is what
   * is shown of it.
   */
  | { type: "slack"; sealed?: string; hint: string; message: string }
) & { id?: string };

export type ApprovalAction = {
  type: "approval";
  userIds: string[];
  propertyIds: string[];
  message: string;
  timeoutDays: number;
  onTimeout: ApprovalTimeout;
};

/** What an approval nobody answered in time does: stops the run, or lets it go on. */
export const APPROVAL_TIMEOUTS = ["stop", "continue"] as const;
export type ApprovalTimeout = (typeof APPROVAL_TIMEOUTS)[number];

export type AutomationActionType = AutomationAction["type"];

export const AUTOMATION_ACTION_TYPES = [
  "set_properties",
  "notify",
  "webhook",
  "run_agent",
  "move_to_trash",
  "http_request",
  "find_rows",
  "create_row",
  "upsert_row",
  "wait",
  "log",
  "celebrate",
  "start_sequence",
  "approval",
  "slack",
] as const satisfies AutomationActionType[];

/**
 * A "celebrate" step later than this after the change that started its run (after a wait, an
 * approval, a busy queue) is skipped: confetti long after the change would come out of nowhere.
 */
export const CELEBRATE_WITHIN_MS = 2 * 60_000;

/** Steps that can go "for each" over found rows. */
export const FOR_EACH_TYPES = ["set_properties", "notify", "run_agent", "start_sequence"] as const satisfies AutomationActionType[];

/** Steps that act on the run's row: a run without one (schedule, incoming webhook) needs "for each" for them. */
export const ROW_STEP_TYPES = ["set_properties", "run_agent", "move_to_trash", "webhook", "start_sequence"] as const satisfies AutomationActionType[];

/** Whether a step needs a row it doesn't have: in a run without one, not going over found rows. */
export function needsRow(action: AutomationAction) {
  if ((ROW_STEP_TYPES as readonly string[]).includes(action.type)) return !("forEach" in action && action.forEach);
  if (action.type === "notify") return !action.forEach && action.propertyIds.length > 0;
  if (action.type === "approval") return action.propertyIds.length > 0;
  return false;
}

/** The found_rows step a step goes over, if any. */
export const forEachOf = (action: AutomationAction): string | null => ("forEach" in action && action.forEach ? action.forEach : null);

/** Each step's id: its own, or `step<n>` (by position, skipping taken ids) for steps saved before ids. */
export function stepIds(actions: { id?: string }[]): string[] {
  const taken = new Set(actions.flatMap((a) => (a.id ? [a.id] : [])));
  return actions.map((a, i) => {
    if (a.id) return a.id;
    let n = i + 1;
    while (taken.has(`step${n}`)) n++;
    taken.add(`step${n}`);
    return `step${n}`;
  });
}

/**
 * The agents the steps run and the database each runs on: the automation's own (`databaseId`), or
 * the database a "for each" goes over. Publishing shares those databases with those agents.
 */
export function agentTargets(actions: AutomationAction[], databaseId: string) {
  const ids = stepIds(actions);
  const out: { agentId: string; databaseId: string }[] = [];
  for (const action of actions) {
    if (action.type !== "run_agent") continue;
    const over = action.forEach ? actions[ids.indexOf(action.forEach)] : null;
    const target = over?.type === "find_rows" ? over.databaseId : databaseId;
    if (!out.some((t) => t.agentId === action.agentId && t.databaseId === target)) out.push({ agentId: action.agentId, databaseId: target });
  }
  return out;
}

/** The actions with their ids written in (see stepIds). */
export const withStepIds = <T extends { id?: string }>(actions: T[]): T[] => {
  const ids = stepIds(actions);
  return actions.map((a, i) => (a.id ? a : { ...a, id: ids[i] }));
};

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

/** At most this many automations per database, and steps per automation. */
export const MAX_AUTOMATIONS = 50;
export const MAX_AUTOMATION_ACTIONS = 20;
/** Rows a find_rows step finds at most, which is also as many as a "for each" goes over. */
export const MAX_FOUND_ROWS = 100;
/** How much of an HTTP response a step keeps (and later steps see). */
export const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
export const MAX_HTTP_HEADERS = 20;
/** A JSON body (as text), a log or notification message, a step's longer text. */
export const MAX_HTTP_BODY = 32_000;
export const MAX_STEP_MESSAGE = 2000;
/** A wait step waits at most seven days. */
export const MAX_WAIT_MINUTES = 7 * 24 * 60;
/**
 * An approval waits at most as long as anything waits in the "For review" queue (lib/pending-changes
 * PENDING_CHANGE_DAYS, which the queue's daily cleanup expires), and that long when not told.
 */
export const MAX_APPROVAL_DAYS = 30;
/** People an approval step names at most (its person properties may add more). */
export const MAX_APPROVERS = 20;
/** The example body an incoming webhook trigger keeps for the editor, as JSON text. */
export const MAX_EXAMPLE_PAYLOAD = 16_000;
/** An incoming webhook's body at most, and how many requests an automation takes a minute. */
export const MAX_INCOMING_BYTES = 64 * 1024;
export const INCOMING_PER_MINUTE = 60;
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
  "unique_id",
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
  // Found by the periodic checks or a request, never by a write.
  if (trigger.type !== "property_changed") return false;
  const changed = changedProperties(write.before, write.after);
  const watched = watchedProperties(trigger);
  if (!watched.length) return !write.created && changed.length > 0;
  if (watched.length > 1) return !write.created && watched.some((id) => changed.includes(id));
  if (trigger.propertyId === null || !changed.includes(trigger.propertyId)) return false;
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
 * dates that are days count by calendar day in `timeZone` (the automation's, that of whoever saved
 * it), times and the row's added/edited times by the clock. Both as text that compares in order
 * with stored values (days as YYYY-MM-DD, times as UTC ISO strings).
 */
export function datePassedCutoffs(days: number, now: Date, timeZone: string) {
  const day = dayString(localDay(now.getTime(), timeZone) - days);
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

/** What started a run without a row. */
export type RunOrigin = "schedule" | "incoming_webhook";

/**
 * The event of a run: a row added or changed, a "date passed" run (it has the date it ran for), a
 * schedule or a request to the automation's address.
 */
export const runEvent = (run: { created: boolean; basis: string | null; origin?: RunOrigin | null }) =>
  run.origin === "schedule" ? "schedule" : run.origin === "incoming_webhook" ? "webhook.received" : run.basis !== null ? "row.date_passed" : webhookEvent(run.created);

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

/** Whether a failed HTTP request step is tried again: network errors, timeouts, 502, 503 and 504 only. */
export function httpRetriable(status: number | null) {
  return status === null || status === 502 || status === 503 || status === 504;
}

/**
 * Why a "date passed" automation's last check couldn't look for rows: its date or status
 * property is deleted (it waits for a restore), or whoever saved it lost full access to the
 * database. Cleared by the next check that can, and by saving it.
 */
export type AutomationCheckError = "propertyDeleted" | "noAccess" | "scheduleInvalid";

/**
 * What a run is: waiting (or waiting to retry, or for an approval), running, done, failed in some
 * step, or stopped by an approval that was rejected or not answered in time.
 */
export const AUTOMATION_RUN_STATUSES = ["pending", "running", "done", "failed", "stopped"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];
/** Runs that are over: kept for the history, then pruned. */
export const FINISHED_RUN_STATUSES = ["done", "failed", "stopped"] as const satisfies AutomationRunStatus[];

/** `stopped`: an approval step that was rejected or not answered in time, which ended the run. */
export type AutomationStepStatus = "pending" | "done" | "failed" | "skipped" | "stopped";

/**
 * An approval step's question as the run keeps it: the "For review" entry, who may answer, until
 * when, and how it was answered (approved or rejected, by whom and when, or timed out).
 */
export type ApprovalState = {
  changeId: string;
  approvers: { id: string; name: string }[];
  expiresAt: string;
  answer?: "approved" | "rejected" | "timedOut";
  answeredBy?: { id: string; name: string } | null;
  answeredAt?: string | null;
  /** A test run: who it would have asked (it asked no one). */
  test?: boolean;
};

/** The code of an approval step a test run skipped: later steps go on, its output empty. */
export const APPROVAL_TEST_CODE = "approvalTest";

/** How a step went for one found row of a "for each". */
export type AutomationStepItem = { rowId: string; title: string; status: "done" | "failed" | "skipped"; code?: string; error?: string };

/**
 * One step of a run. `code` is a short machine-readable reason (`noAccess`, `blocked`,
 * `timeout`, `http`, `dependencyFailed`…); `httpStatus` the HTTP status a webhook or request
 * answered with. `input` (the step with its templates written in) and `output` (what it gave
 * later steps) are as the history shows them: credentials masked, long values cut.
 */
export type AutomationStep = {
  /** Its id in the version that ran (missing in runs from before ids). */
  id?: string;
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
  /** Run an agent for each found row: the runs it queued. */
  agentRunIds?: string[];
  /** When it last started, and how long it took (its last try). */
  startedAt?: string;
  durationMs?: number;
  /** Wait: when the run goes on. */
  waitUntil?: string;
  /** Approval: the question and its answer. */
  approval?: ApprovalState;
  input?: unknown;
  output?: unknown;
  /** For each: how it went for each found row. */
  items?: AutomationStepItem[];
};

/**
 * A run is done when every step is; failed when one failed for good; stopped when an approval
 * stopped it; else it still waits.
 */
export function runStatusOf(steps: AutomationStep[]): AutomationRunStatus {
  if (steps.some((s) => s.status === "pending")) return "pending";
  if (steps.some((s) => s.status === "failed")) return "failed";
  return steps.some((s) => s.status === "stopped") ? "stopped" : "done";
}

/** The run waits for an approval's answer: the step that asks, if any. */
export const waitingApproval = (steps: AutomationStep[]) => steps.find((s) => s.status === "pending" && s.type === "approval" && s.approval && !s.approval.answer) ?? null;

/** Text the signature covers: the timestamp (Unix seconds), a dot, and the raw body. */
export const signedContent = (timestamp: number, body: string) => `${timestamp}.${body}`;

/** The signature header's value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of signedContent>`. */
export const signatureHeader = (timestamp: number, hexSignature: string) => `t=${timestamp},v1=${hexSignature}`;

/**
 * Database automations: "when a row is added, or a property of a row changes (to a value), do
 * these things". Types, the pure trigger matching and the limits, for the server
 * (server/automations) and the settings dialog alike.
 */

/** What starts an automation. */
export type AutomationTrigger =
  /** A row is added to the database, however (the app, a form, an import, MCP, the API). */
  | { type: "row_created" }
  /**
   * A row's value of `propertyId` changes; any property when it is null. With `to`, only when the
   * value becomes it: an option id (select, status), true or false (checkbox), or a user id or
   * option id that gets added (person, multi-select).
   */
  | { type: "property_changed"; propertyId: string | null; to?: string | boolean | null };

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
  | { type: "webhook"; url: string };

export type AutomationActionType = AutomationAction["type"];

export const AUTOMATION_ACTION_TYPES = ["set_properties", "notify", "webhook"] as const satisfies AutomationActionType[];

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
  const changed = changedProperties(write.before, write.after);
  if (trigger.propertyId === null) return !write.created && changed.length > 0;
  if (!changed.includes(trigger.propertyId)) return false;
  // A new row's values weren't changed by anyone: only a "becomes" condition looks at them.
  if (trigger.to === undefined || trigger.to === null) return !write.created;
  return holds(write.after[trigger.propertyId], trigger.to) && !holds(write.before[trigger.propertyId], trigger.to);
}

/** The event name a webhook's body carries. */
export const webhookEvent = (created: boolean) => (created ? "row.created" : "row.updated");

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

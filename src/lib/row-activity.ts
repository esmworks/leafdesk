/**
 * A database row's activity: who changed which of its values (or its title) from what to what,
 * newest first, on the row page, over MCP and the REST API. What is recorded, how quick changes
 * in a row merge into one entry, how stored values read, and whose entries a viewer may see. Pure
 * and client-safe: server/row-activity.ts records entries, server/row-activity-feed.ts lists them.
 */

import { atLeast } from "./property-access";
import type { AccessRow, PropertyAccess } from "./property-access-rows";
import { isReadOnlyType, type PropertyType } from "./property-types";

/**
 * Who made a change: a person, an agent (which acts as a user of its own), an automation (acting
 * as the person who saved it), an AI value (worked out for the person whose request or change set
 * it off, an automation's too) or an anonymous answer to a public form (nobody to name).
 */
export const ROW_ACTIVITY_ACTORS = ["user", "agent", "automation", "ai", "form"] as const;
export type RowActivityActor = (typeof ROW_ACTIVITY_ACTORS)[number];

/**
 * What an entry is about: the row being made, its title, one of its property values, or other rows
 * merged into it (server/merge-rows.ts; `newValue` lists them as {id, title}).
 */
export const ROW_ACTIVITY_KINDS = ["created", "title", "property", "merged"] as const;
export type RowActivityKind = (typeof ROW_ACTIVITY_KINDS)[number];

/**
 * Changes by the same actor to the same value of a row this close together are one entry: typing
 * in a text or number value, or a title, saves many times.
 */
export const COALESCE_WINDOW_MS = 5 * 60_000;

/** The most entries one read returns. */
export const MAX_ACTIVITY_PAGE = 100;

/** Values worked out from the row (formulas, rollups, who and when) are never recorded. */
export const isRecordedType = (type: string) => !isReadOnlyType(type);

/** A value as stored in an entry: null for nothing (undefined, null, "", an empty list). */
export function storedValue(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

/** Whether two values are the same, nothing being the same however it is written. */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(storedValue(a)) === JSON.stringify(storedValue(b));

export type PropertyChange = { propertyId: string; propertyType: PropertyType; oldValue: unknown; newValue: unknown };

/** The recorded properties whose values differ between `before` and `after` of a row write. */
export function changedProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  properties: readonly { id: string; type: PropertyType }[],
): PropertyChange[] {
  // An unticked checkbox is the same as one never ticked.
  const value = (p: { type: PropertyType }, v: unknown) => (p.type === "checkbox" && v === false ? null : storedValue(v));
  return properties.flatMap((p) => {
    if (!isRecordedType(p.type)) return [];
    const [oldValue, newValue] = [value(p, before[p.id]), value(p, after[p.id])];
    return sameValue(oldValue, newValue) ? [] : [{ propertyId: p.id, propertyType: p.type, oldValue, newValue }];
  });
}

/** The newest entry about the same value of the row, as far as merging goes. */
export type OpenEntry = { id: string; actorUserId: string | null; actorKind: RowActivityActor; oldValue: unknown; at: Date };

export type CoalesceDecision = { action: "insert" } | { action: "update"; id: string } | { action: "drop"; id: string };

/**
 * Whether a change starts a new entry or merges into `latest`, the newest entry about the same
 * value: merged when the same actor (never an unnamed one) made it within the window. A merged
 * entry keeps its first old value and takes the new one; when that brings the value back to where
 * it started, the entry goes.
 */
export function coalesce(
  latest: OpenEntry | null,
  change: { actorUserId: string | null; actorKind: RowActivityActor; newValue: unknown },
  now: Date,
  windowMs = COALESCE_WINDOW_MS,
): CoalesceDecision {
  if (
    !latest ||
    !change.actorUserId ||
    latest.actorUserId !== change.actorUserId ||
    latest.actorKind !== change.actorKind ||
    now.getTime() - latest.at.getTime() > windowMs
  ) {
    return { action: "insert" };
  }
  return sameValue(latest.oldValue, change.newValue) ? { action: "drop", id: latest.id } : { action: "update", id: latest.id };
}

/**
 * The properties whose entries a viewer sees: ones they may see the value of in this row (property
 * access, see lib/property-access) and that aren't deleted. Entries about a deleted property show
 * again once it is restored; a property gone for good takes its entries along.
 */
export function readableProperties(
  properties: readonly { id: string; deletedAt: Date | null }[],
  access: Pick<PropertyAccess, "visible" | "levelOf">,
  row: AccessRow,
): Set<string> {
  const known = access.visible(properties.filter((p) => !p.deletedAt));
  return new Set(known.filter((p) => atLeast(access.levelOf(p.id, row), "view")).map((p) => p.id));
}

// ----------------------------------------------------------------------------------- reading

/** A person an entry names: who acted, or who a person value held. */
export type ActivityPerson = { id: string; name: string; image: string | null; isAgent?: true; agentIcon?: string | null };

/** A row a relation value linked to; only its id when the viewer can't open it. */
export type ActivityPage = { id: string; title: string; icon: string | null } | { id: string; noAccess: true };

/** A stored value as it reads, for the row page to word in the viewer's language. */
export type ActivityValue =
  | { type: "empty" }
  | { type: "text"; text: string }
  | { type: "number"; value: number }
  | { type: "checkbox"; checked: boolean }
  /** A date value (lib/date-value), shown in the viewer's time zone. */
  | { type: "date"; value: string }
  /** Options by name and color; `missing` counts the ones the property no longer has. */
  | { type: "options"; options: { name: string; color: string }[]; missing: number }
  | { type: "people"; people: ActivityPerson[]; missing: number }
  | { type: "pages"; pages: ActivityPage[] }
  | { type: "files"; names: string[] }
  | { type: "checklist"; done: number; total: number };

export type ActivityLookups = {
  people: ReadonlyMap<string, ActivityPerson>;
  /** Rows the viewer can open, by id. */
  pages: ReadonlyMap<string, { title: string; icon: string | null }>;
};

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.length > 0);

/** The user and page ids stored values hold, for loading what they read as. */
export function referencedIds(values: readonly { type: PropertyType | null; value: unknown }[]) {
  const people = new Set<string>();
  const pages = new Set<string>();
  for (const { type, value } of values) {
    if (type === "person") for (const id of strings(value)) people.add(id);
    if (type === "relation") for (const id of strings(value)) pages.add(id);
  }
  return { people, pages };
}

/**
 * How a stored value of a property reads. `type` is the property's type when the value was
 * written: a value from before a type change still reads as it was meant. Options are looked up
 * among the property's current ones. Anything not shaped as expected reads as text or nothing,
 * never as an error.
 */
export function resolveValue(
  type: PropertyType | null,
  options: readonly { id: string; name: string; color: string }[],
  value: unknown,
  lookups: ActivityLookups,
): ActivityValue {
  const stored = storedValue(value);
  if (type === "checkbox") return { type: "checkbox", checked: stored === true };
  if (stored === null) return { type: "empty" };
  switch (type) {
    case "number":
      if (typeof stored === "number") return { type: "number", value: stored };
      break;
    case "date":
      if (typeof stored === "string") return { type: "date", value: stored };
      break;
    case "select":
    case "status":
    case "multi_select": {
      const ids = strings(stored);
      const found = ids.flatMap((id) => {
        const option = options.find((o) => o.id === id);
        return option ? [{ name: option.name, color: option.color }] : [];
      });
      return { type: "options", options: found, missing: ids.length - found.length };
    }
    case "person": {
      const ids = strings(stored);
      const people = ids.flatMap((id) => (lookups.people.has(id) ? [lookups.people.get(id)!] : []));
      return { type: "people", people, missing: ids.length - people.length };
    }
    case "relation":
      return {
        type: "pages",
        pages: strings(stored).map((id) => {
          const found = lookups.pages.get(id);
          return found ? { id, title: found.title, icon: found.icon } : { id, noAccess: true as const };
        }),
      };
    case "files":
      if (Array.isArray(stored)) {
        return {
          type: "files",
          names: stored.flatMap((f) => (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string" ? [(f as { name: string }).name] : [])),
        };
      }
      break;
    case "checklist":
      if (Array.isArray(stored)) {
        const items = stored.filter((i): i is { checked?: unknown } => Boolean(i) && typeof i === "object");
        return { type: "checklist", done: items.filter((i) => i.checked === true).length, total: items.length };
      }
      break;
  }
  if (typeof stored === "string") return { type: "text", text: stored };
  if (typeof stored === "number") return { type: "number", value: stored };
  if (typeof stored === "boolean") return { type: "checkbox", checked: stored };
  return { type: "text", text: JSON.stringify(stored) };
}

/** A value in plain English, for MCP and the REST API; null for nothing. Dates stay ISO 8601. */
export function valueText(value: ActivityValue): string | null {
  switch (value.type) {
    case "empty":
      return null;
    case "text":
      return value.text;
    case "number":
      return String(value.value);
    case "checkbox":
      return value.checked ? "checked" : "unchecked";
    case "date":
      return value.value;
    case "options":
      return [...value.options.map((o) => o.name), ...Array<string>(value.missing).fill("(deleted option)")].join(", ");
    case "people":
      return [...value.people.map((p) => p.name), ...Array<string>(value.missing).fill("(unknown person)")].join(", ");
    case "pages":
      return value.pages.map((p) => ("noAccess" in p ? "(no access)" : p.title || "Untitled")).join(", ");
    case "files":
      return value.names.join(", ");
    case "checklist":
      return `${value.done} of ${value.total} done`;
  }
}

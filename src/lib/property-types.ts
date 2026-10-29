// Client-safe: no imports, so UI code can use these without pulling in the database schema.
export const PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "checklist",
  "files",
  "place",
  "relation",
  "person",
  "created_by",
  "created_time",
  "last_edited_by",
  "last_edited_time",
  "formula",
  "rollup",
  "unique_id",
  "button",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * Stored in a person filter's value instead of a user id: whoever is looking at the view, so one
 * saved "Assignee contains me" view shows each person their own rows.
 */
export const PERSON_ME = "me";

/**
 * Types whose values are lists of user ids: people picked by hand, or whoever created or last
 * edited the row.
 */
export function holdsPeople(type: string) {
  return type === "person" || type === "created_by" || type === "last_edited_by";
}

/** Types Leafdesk fills in from the row itself (who and when): never stored, never written. */
export function isComputed(type: string) {
  return type === "created_by" || type === "created_time" || type === "last_edited_by" || type === "last_edited_time";
}

/**
 * Types whose values are worked out when rows are read, never stored or written: formulas from
 * the row's other values, rollups from the rows it links to.
 */
export function isDerived(type: string) {
  return type === "formula" || type === "rollup";
}

/**
 * Types whose values Leafdesk numbers itself (lib/unique-id): stored like any value, but given out
 * when a row is made, never written.
 */
export function isNumbered(type: string) {
  return type === "unique_id";
}

/**
 * Types that hold no value at all: a button (lib/row-buttons) starts the database's automations
 * made for it when someone clicks it on a row.
 */
export function isAction(type: string) {
  return type === "button";
}

/** Types nobody writes: system values, derived values, row numbers and buttons. */
export function isReadOnlyType(type: string) {
  return isComputed(type) || isDerived(type) || isNumbered(type) || isAction(type);
}

/** Types whose values are points in time (ISO timestamps), filtered by day like dates. */
export function holdsTimestamp(type: string) {
  return type === "created_time" || type === "last_edited_time";
}

/** Types whose values are ids of the property's options. */
export function holdsOptions(type: string) {
  return type === "select" || type === "multi_select" || type === "status";
}

/**
 * The stages every status option belongs to, in order. Boards and sorts follow this order, and
 * the option editor lists options under them.
 */
export const STATUS_GROUPS = ["todo", "in_progress", "done"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

/**
 * Property types published pages leave out: relations, whose values point at pages that may not be
 * published (rollups, which calculate over them, go too), people, who didn't agree to have their
 * names on a public page, and buttons, which do nothing for visitors. Copies of published pages
 * leave them out as well.
 */
export const UNPUBLISHED_PROPERTY_TYPES: ReadonlySet<string> = new Set(["relation", "rollup", "person", "created_by", "last_edited_by", "button"]);

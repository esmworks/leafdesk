// Client-safe: only pure helpers, so the property access dialog and cells can use them too.
import { parseFormula } from "./formula";
import { isComputed } from "./property-types";

/**
 * What someone may do with one property of a database, weakest first:
 * - `none`: the property doesn't show at all;
 * - `view_property`: the property shows, its values don't;
 * - `view`: its values show, read-only;
 * - `edit_values`: its values can be changed, the property itself can't;
 * - `edit`: the property can be renamed, changed and deleted too.
 */
export const PROPERTY_LEVELS = ["none", "view_property", "view", "edit_values", "edit"] as const;
export type PropertyLevel = (typeof PROPERTY_LEVELS)[number];

/** Levels an exception can grant a person property's people (their own rows' values only). */
export const PERSON_RULE_LEVELS: readonly PropertyLevel[] = ["view_property", "view", "edit_values"];

/**
 * One entry of a property's access. No principal: everyone with access to the database. Otherwise
 * exactly one of a person, a group, or a person property of the row (the people it names).
 */
export type PropertyRule = {
  propertyId: string;
  userId: string | null;
  groupId: string | null;
  personPropertyId: string | null;
  level: PropertyLevel;
};

/** Access to the database page itself, as `page_access_level` gives it. */
export type DatabaseLevel = "none" | "view" | "comment" | "edit" | "full";

/** Who is looking, for working out their level on each property. */
export type PropertyViewer = { userId: string; groupIds: readonly string[]; databaseLevel: DatabaseLevel };

/**
 * What the client is told about a restricted property: the viewer's level (the highest any row
 * gives them), and whether rows decide it (a person property exception).
 */
export type PropertyAccessInfo = { level: PropertyLevel; perRow: boolean };

export function isPropertyLevel(value: unknown): value is PropertyLevel {
  return typeof value === "string" && (PROPERTY_LEVELS as readonly string[]).includes(value);
}

export const propertyRank = (level: PropertyLevel) => PROPERTY_LEVELS.indexOf(level);

export const atLeast = (level: PropertyLevel, needed: PropertyLevel) => propertyRank(level) >= propertyRank(needed);

const maxLevel = (a: PropertyLevel, b: PropertyLevel) => (propertyRank(a) >= propertyRank(b) ? a : b);
const minLevel = (a: PropertyLevel, b: PropertyLevel) => (propertyRank(a) <= propertyRank(b) ? a : b);

/**
 * Whether a property of this type can be restricted: not relations (the other side
 * would still show the links) and not the values Leafdesk fills in (who and when). The title
 * isn't a property here, so it never can be.
 */
export function canRestrict(type: string) {
  return type !== "relation" && !isComputed(type);
}

/** Types an exception can point at: the people a row names. */
export function namesPeople(type: string) {
  return type === "person" || type === "created_by";
}

/** The most a level on the database page allows on any of its properties. */
export function databaseCap(level: DatabaseLevel): PropertyLevel {
  if (level === "full" || level === "edit") return "edit";
  if (level === "view" || level === "comment") return "view";
  return "none";
}

const names = (value: unknown, userId: string) => Array.isArray(value) && value.includes(userId);

/**
 * The viewer's level on a property with these rules (all of the one property). Without rules, or
 * with full access to the database, it is what their database access allows. Otherwise the entry
 * for everyone (or, without one, the database access) raised by every exception that matches
 * them: the widest wins, and none goes past the database access.
 *
 * `row`: the row's values (with created by filled in), for person property exceptions. Without a
 * row the answer is the most any row could give, which is what decides whether the property shows.
 */
export function resolvePropertyLevel(
  rules: readonly PropertyRule[],
  viewer: PropertyViewer,
  row?: Record<string, unknown> | null,
): PropertyLevel {
  const cap = databaseCap(viewer.databaseLevel);
  if (viewer.databaseLevel === "full" || !rules.length) return cap;
  let level: PropertyLevel = rules.find((r) => !r.userId && !r.groupId && !r.personPropertyId)?.level ?? "edit";
  for (const rule of rules) {
    const matches =
      (rule.userId !== null && rule.userId === viewer.userId) ||
      (rule.groupId !== null && viewer.groupIds.includes(rule.groupId)) ||
      // An anonymous visitor (no user id) is named by no row.
      (rule.personPropertyId !== null && viewer.userId !== "" && (row === undefined || names(row?.[rule.personPropertyId], viewer.userId)));
    if (!matches) continue;
    // A person property's people only ever get to their rows' values, never the property itself.
    level = maxLevel(level, rule.personPropertyId ? minLevel(rule.level, "edit_values") : rule.level);
  }
  return minLevel(level, cap);
}

/** Whether rules decide per row (a person property exception that could raise the level). */
export function dependsOnRow(rules: readonly PropertyRule[], viewer: PropertyViewer) {
  // `null`: a row that names nobody.
  return resolvePropertyLevel(rules, viewer) !== resolvePropertyLevel(rules, viewer, null);
}

/** The property ids a formula expression reads (ids of other properties, or "title"). */
export function formulaReferences(expression: string): string[] {
  return parseFormula(expression).refs;
}

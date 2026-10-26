// Client-safe: no imports beyond property types, so menus can ask which properties may be unique.
import type { PropertyType } from "./property-types";

/**
 * Properties that can keep their values unique (options.unique): no two live rows of the database
 * hold the same value. Postgres keeps the rule (drizzle/0146_unique_values.sql, table
 * unique_value), so every way a row is written is held to it.
 */
export const UNIQUE_VALUE_TYPES = ["text", "number", "email", "url", "phone"] as const satisfies readonly PropertyType[];

export function canBeUnique(type: string): boolean {
  return (UNIQUE_VALUE_TYPES as readonly string[]).includes(type);
}

/**
 * The form two values of a unique property are compared in, as unique_value_key() in SQL works it
 * out: text, emails and links trimmed and in lower case; phone numbers by their digits and "+";
 * numbers by amount (1 and 1.0 are the same). Null for an empty value, which any number of rows
 * may have.
 */
export function uniqueValueKey(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? String(n) : null;
  }
  if (typeof value !== "string") return null;
  const key = type === "phone" ? value.replace(/[^0-9+]/g, "") : value.trim().toLowerCase();
  return key === "" ? null : key;
}

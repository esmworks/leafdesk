// Client-safe: no imports beyond property types, so menus can ask which properties may be unique.
import type { PropertyType } from "./property-types";

/**
 * Properties that can keep their values unique (options.unique): no two live rows of the database
 * hold the same value. Postgres keeps the rule (drizzle/0149_unique_values.sql, table
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

/**
 * The values a batch of row writes (a paste, an import, a sync run) can't keep because a unique
 * property would refuse them. `values` are the batch's values of unique properties with their keys
 * as unique_value_key() folds them, in the order the rows are written (`row` the row's place in the
 * batch, `rowId` for a row already there); `taken` the stored entries (unique_value) with those
 * keys. A value another row holds, or that an earlier row of the batch takes, is refused; a row
 * keeps its own. Returns the refused values.
 */
export function repeatedValues(
  values: readonly { row: number; rowId?: string; propertyId: string; key: string | null }[],
  taken: readonly { rowId: string; propertyId: string; key: string }[],
): { row: number; propertyId: string }[] {
  const holder = new Map<string, string | number>();
  for (const t of taken) holder.set(`${t.propertyId}\u0000${t.key}`, t.rowId);
  const refused: { row: number; propertyId: string }[] = [];
  for (const value of [...values].sort((a, b) => a.row - b.row)) {
    if (value.key === null) continue;
    const slot = `${value.propertyId}\u0000${value.key}`;
    const held = holder.get(slot);
    if (held === undefined || held === (value.rowId ?? value.row)) holder.set(slot, value.rowId ?? value.row);
    else refused.push({ row: value.row, propertyId: value.propertyId });
  }
  return refused;
}

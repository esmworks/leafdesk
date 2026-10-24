// Client-safe: unique ID values, their prefix and how they read as text (no server imports).

/**
 * A unique ID property numbers a database's rows 1, 2, 3… in the order they are created and shows
 * each number after the property's prefix: "TASK-12". The number is stored in the row's values and
 * given out by Postgres whatever made the row (see drizzle/*_unique_id.sql); the prefix is in the
 * property's options, so changing it only changes how IDs read. Numbers are never given out twice,
 * not even after a row is deleted for good.
 */

/** Longest prefix a unique ID property takes. */
export const MAX_UNIQUE_ID_PREFIX = 10;

const PREFIX = new RegExp(`^[A-Z0-9]{1,${MAX_UNIQUE_ID_PREFIX}}$`);

/**
 * A prefix as typed, as stored: trimmed, without a trailing dash ("TASK-" is "TASK"), upper case.
 * Null for none (left empty); undefined when it isn't letters and digits or is too long. Letters are
 * the 26 of the Latin alphabet, so an ID typed on any keyboard finds its row.
 */
export function cleanUniqueIdPrefix(input: unknown): string | null | undefined {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") return undefined;
  const prefix = input.trim().replace(/-+$/, "").toUpperCase();
  if (!prefix) return null;
  return PREFIX.test(prefix) ? prefix : undefined;
}

/** A stored ID number; null for anything else (a row template, which has none). */
export function uniqueIdNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An ID as people see it: "TASK-12", or "12" without a prefix; "" for a row without a number. */
export function formatUniqueId(value: unknown, prefix?: string | null): string {
  const n = uniqueIdNumber(value);
  if (n === null) return "";
  return prefix ? `${prefix}-${n}` : String(n);
}

/** The prefix of a unique ID property (lib/unique-id), if it has one. */
export function uniqueIdPrefix(prop: { options: { uniqueId?: { prefix?: string | null } } }): string | null {
  return prop.options.uniqueId?.prefix || null;
}

/**
 * The number an ID typed into a filter or a tool names: "TASK-12", "task-12", "TASK 12" or just
 * "12". A typed prefix must be the property's (`prefix`; none when null). Null when the text isn't
 * one of its IDs.
 */
export function parseUniqueId(input: unknown, prefix: string | null): number | null {
  if (typeof input === "number") return uniqueIdNumber(input);
  if (typeof input !== "string") return null;
  const match = /^\s*(?:([A-Za-z0-9]{1,10}?)\s*[-\s]\s*)?(\d{1,15})\s*$/.exec(input);
  if (!match) return null;
  if (match[1] && match[1].toUpperCase() !== (prefix ?? "")) return null;
  return uniqueIdNumber(Number(match[2]));
}

/**
 * A search query that is a whole ID with its prefix ("TASK-12", "task-12"): the prefix in upper
 * case and the number. Null for anything else, a bare number included: it would name row 12 of
 * every database without a prefix.
 */
export function uniqueIdQuery(query: string): { prefix: string; number: number } | null {
  const match = /^\s*([A-Za-z0-9]{1,10})-(\d{1,15})\s*$/.exec(query);
  if (!match || /^\d+$/.test(match[1])) return null;
  const number = uniqueIdNumber(Number(match[2]));
  return number === null ? null : { prefix: match[1].toUpperCase(), number };
}

/**
 * Row access (server/row-access.ts): what a database's rows give the people they name. A rule
 * gives the people in a person property of the row, or the row's creator, a level on that row and
 * the pages under it, on top of what they have from sharing. A database whose rows are
 * `restricted` shows each row only to those a rule or the row's own sharing names, and to people
 * with full access to the database. The SQL function `page_access_level` applies both (see
 * drizzle/0118_row_access.sql); this module is the shape and the checks, shared with the client.
 */

import { PropertyValueError } from "./properties";

export const ROW_ACCESS_LEVELS = ["view", "comment", "edit", "full"] as const;
export type RowAccessLevel = (typeof ROW_ACCESS_LEVELS)[number];

export type RowAccessRule = { kind: "person"; propertyId: string; level: RowAccessLevel } | { kind: "creator"; level: RowAccessLevel };

export type RowAccessConfig = { restricted: boolean; rules: RowAccessRule[] };

export const NO_ROW_ACCESS: RowAccessConfig = { restricted: false, rules: [] };

/** Rules one database may have: one per person property, and one for the creator. */
export const MAX_ROW_ACCESS_RULES = 20;

const isLevel = (value: unknown): value is RowAccessLevel => typeof value === "string" && (ROW_ACCESS_LEVELS as readonly string[]).includes(value);

/**
 * Checks and narrows a row access setting as sent by a client. `properties` are the database's
 * live properties; a rule must name a person property among them, each at most once.
 */
export function parseRowAccess(input: unknown, properties: { id: string; type: string }[]): RowAccessConfig {
  if (typeof input !== "object" || input === null) throw new PropertyValueError("Row access must be an object", "invalidRowAccess");
  const { restricted, rules } = input as { restricted?: unknown; rules?: unknown };
  if (typeof restricted !== "boolean" || !Array.isArray(rules)) throw new PropertyValueError("Row access needs restricted and rules", "invalidRowAccess");
  if (rules.length > MAX_ROW_ACCESS_RULES) throw new PropertyValueError("Too many row access rules", "invalidRowAccess");
  const seen = new Set<string>();
  const parsed = rules.map((rule): RowAccessRule => {
    if (typeof rule !== "object" || rule === null) throw new PropertyValueError("A rule must be an object", "invalidRowAccess");
    const { kind, propertyId, level } = rule as { kind?: unknown; propertyId?: unknown; level?: unknown };
    if (!isLevel(level)) throw new PropertyValueError("A rule needs a level", "invalidRowAccess");
    if (kind === "creator") {
      if (seen.has("creator")) throw new PropertyValueError("The creator has one rule", "invalidRowAccess");
      seen.add("creator");
      return { kind, level };
    }
    if (kind !== "person" || typeof propertyId !== "string") throw new PropertyValueError("A rule names a person property or the creator", "invalidRowAccess");
    const property = properties.find((p) => p.id === propertyId);
    if (!property) throw new PropertyValueError("No such property", "invalidRowAccess");
    if (property.type !== "person") throw new PropertyValueError("Only person properties give access", "invalidRowAccess");
    if (seen.has(propertyId)) throw new PropertyValueError("A property has one rule", "invalidRowAccess");
    seen.add(propertyId);
    return { kind, propertyId, level };
  });
  return { restricted, rules: parsed };
}

/** The setting as stored, read leniently: rules that no longer make sense are left out. */
export function readRowAccess(stored: { restricted: boolean; rules: unknown } | undefined | null): RowAccessConfig {
  if (!stored) return NO_ROW_ACCESS;
  const rules = Array.isArray(stored.rules)
    ? stored.rules.flatMap((rule): RowAccessRule[] => {
        const { kind, propertyId, level } = (rule ?? {}) as { kind?: unknown; propertyId?: unknown; level?: unknown };
        if (!isLevel(level)) return [];
        if (kind === "creator") return [{ kind, level }];
        if (kind === "person" && typeof propertyId === "string") return [{ kind, propertyId, level }];
        return [];
      })
    : [];
  return { restricted: stored.restricted, rules };
}

/** Whether the setting changes anything; one that doesn't isn't stored. */
export const rowAccessInUse = (config: RowAccessConfig) => config.restricted || config.rules.length > 0;

/** The setting for a copy of the database, its properties renamed by `propertyIds` (old → new). */
export function remapRowAccess(config: RowAccessConfig, propertyIds: Map<string, string>): RowAccessConfig {
  return {
    restricted: config.restricted,
    rules: config.rules.flatMap((rule) => {
      if (rule.kind === "creator") return [rule];
      const id = propertyIds.get(rule.propertyId);
      return id ? [{ ...rule, propertyId: id }] : [];
    }),
  };
}

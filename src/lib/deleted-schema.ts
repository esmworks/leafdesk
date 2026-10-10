// Deleted database properties and views (see server/databases deleteProperty and deleteView): what
// stays hidden while they are deleted and how a restored property is named. Pure, so tests and the
// client can use it.
import type { FilterEntry, FilterRule, ViewConfig, ViewType } from "@/db/schema/app";
import { dropPropertyReferences } from "./duplicate";
import { mapFilterRules } from "./filters";
import { restoreReferences } from "./property-access-rows";
import type { PropertyType } from "./property-types";

/**
 * A row's values without those of properties not in `properties` (deleted ones): rows keep a
 * deleted property's values for a restore, but nothing shows, exports or searches them meanwhile.
 */
export function livePropertyValues(values: Record<string, unknown>, properties: { id: string }[]): Record<string, unknown> {
  const live = new Set(properties.map((p) => p.id));
  let stale = false;
  for (const id in values) {
    if (!live.has(id)) {
      stale = true;
      break;
    }
  }
  if (!stale) return values;
  return Object.fromEntries(Object.entries(values).filter(([id]) => live.has(id)));
}

/**
 * `name`, or `name 2`, `name 3`… so it doesn't clash with `taken` (names compared without case and
 * surrounding spaces; "title" is always taken, as the row's name). New, copied and restored
 * properties are all named this way.
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.trim().toLowerCase()));
  names.add("title");
  let candidate = name;
  for (let i = 2; names.has(candidate.trim().toLowerCase()); i++) candidate = `${name} ${i}`;
  return candidate;
}

/**
 * A view's settings as read while the properties in `deleted` are deleted: what it says about them
 * is ignored, rule by rule (a filter group keeps its other rules; one left empty goes). The stored
 * settings keep it, for a restore.
 */
export function withoutDeleted(config: ViewConfig, deleted: ReadonlySet<string>): ViewConfig {
  return deleted.size ? dropPropertyReferences(config, (id) => deleted.has(id)) : config;
}

/**
 * A view's new settings, saved from what `withoutDeleted` showed, with what the stored settings
 * said about deleted properties put back. Filters someone didn't change stay exactly as stored;
 * changed ones keep the deleted properties' rules, added at the top level (where in the new tree
 * they belonged can't be told).
 */
export function keepDeleted(stored: ViewConfig, next: ViewConfig, deleted: ReadonlySet<string>): ViewConfig {
  if (!deleted.size) return next;
  const { filters: _filters, ...rest } = stored;
  const out = restoreReferences(rest, next, deleted);
  const storedFilters = stored.filters ?? [];
  const lost: FilterRule[] = [];
  mapFilterRules(storedFilters, (rule) => {
    if (deleted.has(rule.propertyId)) lost.push(rule);
    return rule;
  });
  if (!lost.length) return out;
  const shown = withoutDeleted({ filters: storedFilters }, deleted).filters ?? [];
  const unchanged = JSON.stringify(next.filters ?? []) === JSON.stringify(shown);
  const filters: FilterEntry[] = unchanged ? storedFilters : [...(next.filters ?? []), ...lost];
  return { ...out, filters };
}

/** A deleted property as the "Deleted properties" list shows it. */
export type DeletedProperty = {
  id: string;
  name: string;
  type: PropertyType;
  deletedAt: Date;
  /** The name of who deleted it; null when their account is gone. */
  deletedBy: string | null;
  /** The other side of its two-way relation, deleted and restored with it, when on the same database. */
  pairedName: string | null;
};

/** A deleted view as the "Deleted views" list shows it. */
export type DeletedView = { id: string; name: string; type: ViewType; deletedAt: Date; deletedBy: string | null };

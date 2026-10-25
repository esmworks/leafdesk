/**
 * How many cards a board column or a gallery shows before *Load more* (ViewConfig loadLimit). A
 * database of thousands of rows would otherwise draw every card at once; the rows are all loaded
 * (filters, sorts and calculations still see each one), only the cards drawn are limited. Pure.
 */
import type { LoadLimit, ViewConfig } from "@/db/schema/app";

export const LOAD_LIMITS = [10, 25, 50, 100] as const satisfies readonly LoadLimit[];
export const DEFAULT_LOAD_LIMIT: LoadLimit = 50;

export const isLoadLimit = (value: unknown): value is LoadLimit => LOAD_LIMITS.includes(value as LoadLimit);

/** The view's load limit, or the default. */
export const loadLimitOf = (config: Pick<ViewConfig, "loadLimit">): LoadLimit =>
  isLoadLimit(config.loadLimit) ? config.loadLimit : DEFAULT_LOAD_LIMIT;

/**
 * The first `count` rows, and the rows of `keep` (cards added here, which land further down, e.g. at
 * the end) where they stand. `hidden` is how many rows are left out.
 */
export function firstRows<R extends { id: string }>(rows: readonly R[], count: number, keep: readonly string[] = []): { shown: R[]; hidden: number } {
  if (rows.length <= count) return { shown: rows as R[], hidden: 0 };
  const kept = new Set(keep);
  const shown = rows.filter((row, i) => i < count || kept.has(row.id));
  return { shown, hidden: rows.length - shown.length };
}

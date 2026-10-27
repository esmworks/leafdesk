import type { ChartSort, PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import type { AggregateFn, AggregateResult } from "./aggregate";
import { chartAggregateFunctionsOf, CHART_SORTS, fillDateGaps, measureRows, type ChartMeasure } from "./chart";
import { isErrorValue, valueType } from "./derived";
import { arrangeGroups, boardGroupProperty, groupRowsBy, type Group, type GroupContext, type GroupSettings } from "./grouping";
import { groupsByText, isPivotGroupable } from "./pivot-axis";
import { holdsTimestamp } from "./property-types";

export { isPivotGroupable };

/**
 * Pivot views: rows grouped by one property (`groupBy`, arranged like a chart's groups) and
 * columns by another (`columnBy`), each cell the view's measure over the rows in both (lib/chart
 * ChartMeasure: a count, or a sum, average, median, smallest or largest number). Totals measure
 * the rows they cover, each counted once, never the cells added up: an average's total is the
 * average of its rows, a row with two tags counts once in its row's total, and a sum keeps to its
 * values' decimals as a table footer does. Pure: no React, no database.
 */

/** What a pivot's cells calculate besides counting rows (the measure when no calculation is set). */
export const PIVOT_AGGREGATE_FNS = ["sum", "average", "median", "min", "max"] as const satisfies readonly AggregateFn[];

export function isPivotAggregateFn(fn: unknown): fn is (typeof PIVOT_AGGREGATE_FNS)[number] {
  return (PIVOT_AGGREGATE_FNS as readonly unknown[]).includes(fn);
}

type PivotProp = { id: string; type: PropertyType; options: PropertyOptions };

/** The calculations a pivot offers over a property: numbers, number formulas and rollups. */
export function pivotAggregateFunctionsOf(prop: { type: PropertyType; options: PropertyOptions }): AggregateFn[] {
  return chartAggregateFunctionsOf(prop).filter(isPivotAggregateFn);
}

/** What the cells show; a calculation whose property is gone (or no longer offers it) counts rows. */
export function pivotMeasure(config: Pick<ViewConfig, "chartAggregate">, properties: PivotProp[]): ChartMeasure {
  const agg = config.chartAggregate;
  const prop = agg && properties.find((p) => p.id === agg.propertyId);
  if (!agg || !prop || !pivotAggregateFunctionsOf(prop).includes(agg.fn)) return { kind: "count" };
  return { kind: "aggregate", fn: agg.fn, prop: { id: prop.id, type: valueType(prop), options: prop.options } };
}

/** The property the rows stand for: the saved one while it can group, else the one a board would take. */
export function pivotRowProperty<P extends PivotProp>(properties: P[], config: Pick<ViewConfig, "groupBy">): P | null {
  return properties.find((p) => p.id === config.groupBy && isPivotGroupable(p)) ?? boardGroupProperty(properties, config.groupBy) ?? null;
}

/** The property the columns stand for, while it can group and isn't the rows' one; null for none. */
export function pivotColumnProperty<P extends PivotProp>(properties: P[], config: Pick<ViewConfig, "columnBy">, rows: { id: string } | null): P | null {
  if (!config.columnBy || config.columnBy === rows?.id) return null;
  return properties.find((p) => p.id === config.columnBy && isPivotGroupable(p)) ?? null;
}

export function columnSortOf(config: Pick<ViewConfig, "columnSort">): ChartSort {
  return CHART_SORTS.includes(config.columnSort as ChartSort) ? config.columnSort! : "group";
}

function rowSortOf(config: Pick<ViewConfig, "chartSort">): ChartSort {
  return CHART_SORTS.includes(config.chartSort as ChartSort) ? config.chartSort! : "group";
}

/** The column property's grouping settings, which the view keeps apart from the rows'. */
export function columnSettings(config: Pick<ViewConfig, "columnDateBy" | "columnStatusBy">): GroupSettings {
  return { groupDateBy: config.columnDateBy, groupStatusBy: config.columnStatusBy };
}

/**
 * Groups rows for a pivot: text by its value (trimmed; the no-value group first, then the texts
 * in alphabetical order), anything else as other views group it (lib/grouping groupRowsBy).
 */
export function pivotGroups<T extends { properties: Record<string, unknown> }>(
  rows: T[],
  prop: PivotProp,
  settings: GroupSettings = {},
  context: GroupContext = {},
): Group<T>[] {
  if (!groupsByText(prop)) return groupRowsBy(rows, prop, settings, context);
  const none: Group<T> = { key: "", option: null, value: { kind: "none" }, rows: [] };
  const byText = new Map<string, Group<T>>();
  for (const row of rows) {
    const value = row.properties[prop.id];
    const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    if (!text || isErrorValue(value)) {
      none.rows.push(row);
      continue;
    }
    let group = byText.get(text);
    if (!group) byText.set(text, (group = { key: text, option: null, value: { kind: "text", text }, rows: [] }));
    group.rows.push(row);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [none, ...[...byText.values()].sort((a, b) => collator.compare(a.key, b.key))];
}

/** Columns a pivot shows at most; the rest are left out, and counted (PivotData moreColumns). */
export const MAX_PIVOT_COLUMNS = 100;

/**
 * A measured bunch of rows: `amount` is what sorting compares (0 when `result` is null). `count` is
 * how many rows there were when they were left out to send the pivot (see withoutPivotRows).
 */
export type PivotCell<T> = { rows: T[]; result: AggregateResult | null; amount: number; count?: number };
export type PivotHeader<T> = Pick<Group<T>, "key" | "value"> & { total: PivotCell<T> };
/** A row of the pivot: its group, its cells (one per column, same order) and its total. */
export type PivotLine<T> = PivotHeader<T> & { cells: PivotCell<T>[] };

export type PivotData<T> = {
  /** The column groups; empty when the view has no column property, its rows then showing their totals only. */
  columns: PivotHeader<T>[];
  rows: PivotLine<T>[];
  /** The measure over every row of the pivot, each once. */
  grand: PivotCell<T>;
  /** Column groups left out past MAX_PIVOT_COLUMNS. */
  moreColumns: number;
};

export type PivotInput = {
  rowBy: PivotProp;
  columnBy: PivotProp | null;
  measure: ChartMeasure;
  config: Pick<ViewConfig, "groupDateBy" | "groupStatusBy" | "groupOrder" | "hiddenGroups" | "hideEmptyGroups" | "chartSort" | "columnDateBy" | "columnStatusBy" | "columnSort">;
  rowContext?: GroupContext;
  columnContext?: GroupContext;
};

function cellOf<T extends { properties: Record<string, unknown> }>(rows: T[], measure: ChartMeasure): PivotCell<T> {
  const result = measureRows(rows, measure);
  return { rows, result, amount: result && result.format !== "date" ? result.value : 0 };
}

/** How many rows a cell or total stands for, whether or not they came along. */
export function pivotRowCount(cell: { rows: unknown[]; count?: number }) {
  return cell.count ?? cell.rows.length;
}

function isDateLike(type: PropertyType) {
  return type === "date" || holdsTimestamp(type);
}

/** The no-value group goes last unless the view placed it (a pivot reads from its first real value). */
function noValueLast<G extends Pick<Group<unknown>, "value">>(groups: G[], placed: boolean): G[] {
  if (placed) return groups;
  return [...groups.filter((g) => g.value.kind !== "none"), ...groups.filter((g) => g.value.kind === "none")];
}

/** Sorted by `sort`: by value both ways keep groups without a value (an average of nothing) last; ties keep their order. */
function sortedBy<G extends { total: PivotCell<unknown> }>(groups: G[], sort: ChartSort): G[] {
  if (sort === "group") return groups;
  const sign = sort === "value_desc" ? -1 : 1;
  return [...groups].sort((a, b) => {
    if (!a.total.result || !b.total.result) return (a.total.result ? 0 : 1) - (b.total.result ? 0 : 1);
    return sign * (a.total.amount - b.total.amount);
  });
}

/** Rows in any of `lists`, each once, in first-seen order. */
function union<T>(lists: T[][]): T[] {
  return [...new Set(lists.flat())];
}

/**
 * The pivot of `rows`. Row groups are arranged like a chart's (saved order, hidden groups, empty
 * ones left out on request, the no-value group last, empty dates between the first and last
 * filled in); column groups come from the rows shown, in their natural order or by value, the
 * no-value column only while it has rows. A row with two tags (or two people, or two linked rows)
 * is in two groups.
 */
export function pivotData<T extends { properties: Record<string, unknown> }>(rows: T[], input: PivotInput): PivotData<T> {
  const { rowBy, columnBy, measure, config } = input;
  let grouped = pivotGroups(rows, rowBy, { groupDateBy: config.groupDateBy, groupStatusBy: config.groupStatusBy }, input.rowContext);
  if (isDateLike(rowBy.type) && !config.hideEmptyGroups) grouped = fillDateGaps(grouped);
  const shown = noValueLast(arrangeGroups(grouped, config).shown, !!config.groupOrder?.includes(""));
  const shownRows = union(shown.map((g) => g.rows));

  let columns: (PivotHeader<T> & { members: Set<T> })[] = [];
  let moreColumns = 0;
  if (columnBy) {
    let columnGroups = pivotGroups(shownRows, columnBy, columnSettings(config), input.columnContext);
    if (isDateLike(columnBy.type) && !config.hideEmptyGroups) columnGroups = fillDateGaps(columnGroups);
    const kept = noValueLast(
      columnGroups.filter((g) => g.rows.length > 0 || (g.value.kind !== "none" && !config.hideEmptyGroups)),
      false,
    );
    columns = sortedBy(
      kept.map((g) => ({ key: g.key, value: g.value, total: cellOf(g.rows, measure), members: new Set(g.rows) })),
      columnSortOf(config),
    );
    moreColumns = Math.max(0, columns.length - MAX_PIVOT_COLUMNS);
    columns = columns.slice(0, MAX_PIVOT_COLUMNS);
  }

  const lines: PivotLine<T>[] = shown.map((g) => {
    if (!columns.length) return { key: g.key, value: g.value, total: cellOf(g.rows, measure), cells: [] };
    const cells = columns.map((c) => cellOf(g.rows.filter((r) => c.members.has(r)), measure));
    return { key: g.key, value: g.value, total: cellOf(union(cells.map((c) => c.rows)), measure), cells };
  });

  // With columns left out, a column's total and the grand total cover the columns shown.
  const covered = columns.length ? union(columns.map((c) => [...c.members])) : shownRows;
  return {
    columns: columns.map(({ key, value, total }) => ({ key, value, total })),
    rows: sortedBy(lines, rowSortOf(config)),
    grand: cellOf(covered, measure),
    moreColumns,
  };
}

/** The pivot with each cell's rows replaced by their count: what a published page sends. */
export function withoutPivotRows<T>(data: PivotData<T>): PivotData<never> {
  const strip = (c: PivotCell<T>): PivotCell<never> => ({ rows: [], result: c.result, amount: c.amount, count: pivotRowCount(c) });
  return {
    columns: data.columns.map((c) => ({ key: c.key, value: c.value, total: strip(c.total) })),
    rows: data.rows.map((r) => ({ key: r.key, value: r.value, total: strip(r.total), cells: r.cells.map(strip) })),
    grand: strip(data.grand),
    moreColumns: data.moreColumns,
  };
}

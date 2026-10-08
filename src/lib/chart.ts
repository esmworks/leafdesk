import type { ChartAccumulate, ChartSort, ChartType, PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import {
  AGGREGATE_FNS,
  aggregateFunctions,
  aggregateValues,
  isAggregateFn,
  type AggregateFn,
  type AggregateResult,
} from "./aggregate";
import { valueType } from "./derived";
import {
  arrangeGroups,
  boardGroupProperty,
  dateBucket,
  groupDateByOf,
  groupRowsBy,
  isGroupable,
  type Group,
  type GroupContext,
  type GroupedProperty,
  type GroupValue,
} from "./grouping";
import { holdsTimestamp } from "./property-types";

/**
 * Chart views: rows grouped by a property (lib/grouping), measured per group by counting rows or
 * by a calculation over one property (lib/aggregate). Pure: no React, no database.
 */

export const CHART_TYPES = ["bar", "horizontal_bar", "line", "donut"] as const satisfies readonly ChartType[];
export const CHART_SORTS = ["group", "value_desc", "value_asc"] as const satisfies readonly ChartSort[];
export const CHART_ACCUMULATES = ["cumulative", "remaining"] as const satisfies readonly ChartAccumulate[];
export const DEFAULT_CHART_TYPE: ChartType = "bar";

/**
 * At most this many slices or stack segments get their own color; the rest fold into "Other".
 * Past eight, categorical colors stop being told apart.
 */
export const MAX_CHART_SERIES = 8;
/** The key of the folded "Other" slice or segment; group keys are ids, days or "" (see lib/grouping). */
export const OTHER_KEY = "__other__";
/** Date axes are filled with the empty buckets in between, up to this many. */
const MAX_FILLED_BUCKETS = 400;

export function chartTypeOf(config: Pick<ViewConfig, "chartType">): ChartType {
  return CHART_TYPES.includes(config.chartType as ChartType) ? config.chartType! : DEFAULT_CHART_TYPE;
}

export function chartSortOf(config: Pick<ViewConfig, "chartSort">): ChartSort {
  return CHART_SORTS.includes(config.chartSort as ChartSort) ? config.chartSort! : "group";
}

/** Calculations a chart can measure: count_all is what counting rows does, and a date is no length. */
const NOT_CHARTED = new Set<AggregateFn>(["count_all", "earliest_date", "latest_date"]);

/** The calculations a chart offers over a property of this type, in menu order. */
export function chartAggregateFunctions(type: string): AggregateFn[] {
  return aggregateFunctions(type).filter((fn) => !NOT_CHARTED.has(fn));
}

/** Every calculation some property type can chart. */
export const CHART_AGGREGATE_FNS: AggregateFn[] = AGGREGATE_FNS.filter((fn) => !NOT_CHARTED.has(fn));

export function isChartAggregateFn(fn: unknown): fn is AggregateFn {
  return isAggregateFn(fn) && !NOT_CHARTED.has(fn);
}

/** Measures whose group values add up, so a bar can be split into segments that sum to it. */
const ADDITIVE = new Set<AggregateFn>(["sum", "count_values", "count_empty", "count_not_empty", "count_checked", "count_unchecked"]);

export type ChartProperty = GroupedProperty & { name?: string };

/** What each group is measured by: its row count, or a calculation over one property. */
export type ChartMeasure = { kind: "count" } | { kind: "aggregate"; fn: AggregateFn; prop: { id: string; type: PropertyType; options: PropertyOptions } };

/**
 * The calculations a chart offers over a property: formulas and rollups calculate like a property
 * of their result type (a number formula sums), and rows where a formula failed count as empty.
 */
export function chartAggregateFunctionsOf(prop: { type: PropertyType; options: PropertyOptions }): AggregateFn[] {
  return chartAggregateFunctions(valueType(prop));
}

/** The view's measure; a calculation whose property is gone (or no longer offers it) counts rows. */
export function chartMeasure(config: Pick<ViewConfig, "chartAggregate">, properties: ChartProperty[]): ChartMeasure {
  const agg = config.chartAggregate;
  const prop = agg && properties.find((p) => p.id === agg.propertyId);
  if (!agg || !prop || !chartAggregateFunctionsOf(prop).includes(agg.fn)) return { kind: "count" };
  return { kind: "aggregate", fn: agg.fn, prop: { id: prop.id, type: valueType(prop), options: prop.options } };
}

/** Whether group values add up to a meaningful total (the values of an average don't). */
export function isAdditive(measure: ChartMeasure) {
  return measure.kind === "count" || ADDITIVE.has(measure.fn);
}

/** Whether bars can be stacked under this measure: segments must add up to their bar. */
export function canStack(chartType: ChartType, measure: ChartMeasure) {
  return (chartType === "bar" || chartType === "horizontal_bar") && isAdditive(measure);
}

/**
 * Properties a bar can be split by: those holding one value per row, so each row lands in exactly
 * one segment and the segments add up to the bar. A row with two tags would be counted twice.
 */
export function isStackable(type: PropertyType) {
  return isGroupable(type) && type !== "multi_select" && type !== "relation" && type !== "person";
}

/**
 * Whether a chart can show running totals: over a date (or created or edited time), with a measure
 * whose values add up, on bars or a line (a donut has no order to run along).
 */
export function canAccumulate(chartType: ChartType, groupBy: { type: PropertyType } | null | undefined, measure: ChartMeasure) {
  return !!groupBy && isDateLike(groupBy.type) && isAdditive(measure) && chartType !== "donut";
}

/** The view's running totals, or null to plot each period on its own (also when the chart can't run them). */
export function chartAccumulateOf(
  config: Pick<ViewConfig, "chartAccumulate" | "chartType">,
  groupBy: { type: PropertyType } | null | undefined,
  measure: ChartMeasure,
): ChartAccumulate | null {
  const mode = config.chartAccumulate;
  if (!mode || !CHART_ACCUMULATES.includes(mode)) return null;
  return canAccumulate(chartTypeOf(config), groupBy, measure) ? mode : null;
}

/** Whether values are whole counts, so axis ticks never fall between them. */
export function countsWholeNumbers(measure: ChartMeasure) {
  return measure.kind === "count" || measure.fn.startsWith("count_");
}

/** How the measure's values show: `percent` values are fractions, `days` lengths of time. */
export function measureFormat(measure: ChartMeasure): "number" | "percent" | "days" {
  if (measure.kind === "count") return "number";
  if (measure.fn.startsWith("percent_")) return "percent";
  return measure.fn === "date_range" ? "days" : "number";
}

/** The measure over some rows; null when there is nothing to show (an average of no numbers). */
export function measureRows(rows: { properties: Record<string, unknown> }[], measure: ChartMeasure): AggregateResult | null {
  if (measure.kind === "count") return { format: "number", value: rows.length };
  return aggregateValues(
    rows.map((r) => r.properties[measure.prop.id]),
    measure.fn,
    { type: measure.prop.type, options: measure.prop.options },
  );
}

/** A measured bunch of rows: `amount` is what gets plotted (0 when `result` is null). */
type Measured<T> = { rows: T[]; result: AggregateResult | null; amount: number };

function measured<T extends { properties: Record<string, unknown> }>(rows: T[], measure: ChartMeasure): Measured<T> {
  const result = measureRows(rows, measure);
  const amount = result && result.format !== "date" ? result.value : 0;
  return { rows, result, amount };
}

/** A group on the chart. `other` marks the folded "Other" slice, whose `value` is none. */
export type ChartGroup<T> = Measured<T> & {
  key: string;
  value: GroupValue;
  other?: boolean;
  /**
   * The group's categorical color slot: its place in the grouping's order (before sorting by
   * value), so a group keeps its color when values change. Folded donuts number the kept slices.
   */
  slot: number;
  /** Stacked bars: one segment per series (same order as ChartData.series), empty ones included. */
  segments: (Measured<T> & { key: string })[];
  /**
   * Running totals (see chartAccumulateOf): the period's own rows and value. The group's `rows`
   * are then what its value measures: the rows up to the period, or those left after it.
   */
  period?: Measured<T>;
};

/** A stack series: the segments of one value of the stack property across the bars. */
export type ChartSeries = { key: string; value: GroupValue; other?: boolean; slot: number };

export type ChartData<T> = {
  groups: ChartGroup<T>[];
  /** Stacked bars only; empty otherwise. */
  series: ChartSeries[];
  format: "number" | "percent" | "days";
  /** The smallest and largest plotted amount (a stacked bar counts as its total), 0 included. */
  min: number;
  max: number;
  /**
   * The measure over every row on the chart, each counted once: a row in two groups (two tags)
   * is in two slices but only once in the total.
   */
  total: number;
};

export type ChartInput = {
  groupBy: ChartProperty;
  /** Bar charts: the stack property, when the measure can stack. */
  stackBy?: ChartProperty | null;
  measure: ChartMeasure;
  config: Pick<
    ViewConfig,
    "chartType" | "chartSort" | "chartAccumulate" | "groupDateBy" | "groupStatusBy" | "groupOrder" | "hiddenGroups" | "hideEmptyGroups"
  >;
  context?: GroupContext;
  stackContext?: GroupContext;
};

function isDateLike(type: PropertyType) {
  return type === "date" || holdsTimestamp(type);
}

function nextDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Date groups with the empty buckets between the first and the last one added, so a line over
 * time doesn't skip quiet months. Left as they are when that would add too many.
 */
export function fillDateGaps<T>(groups: Group<T>[]): Group<T>[] {
  const dated = groups.filter((g) => g.value.kind === "date");
  if (dated.length < 2) return groups;
  const first = dated[0].value as Extract<GroupValue, { kind: "date" }>;
  const last = dated[dated.length - 1].value as Extract<GroupValue, { kind: "date" }>;
  const byKey = new Map(dated.map((g) => [g.key, g]));
  const filled: Group<T>[] = [];
  for (let bucket = { start: first.start, end: first.end }; bucket.start <= last.start; bucket = dateBucket(nextDay(bucket.end), first.by)) {
    if (filled.length >= MAX_FILLED_BUCKETS) return groups;
    filled.push(
      byKey.get(bucket.start) ?? {
        key: bucket.start,
        option: null,
        value: { kind: "date", by: first.by, start: bucket.start, end: bucket.end },
        rows: [],
      },
    );
  }
  return [...groups.filter((g) => g.value.kind !== "date"), ...filled];
}

/** The no-value group goes last on a chart (an axis reads from its first real value) unless the view placed it. */
function noValueLast<G extends { key: string; value: GroupValue }>(groups: G[], order: string[] | undefined): G[] {
  if (order?.includes("")) return groups;
  return [...groups.filter((g) => g.value.kind !== "none"), ...groups.filter((g) => g.value.kind === "none")];
}

/** Rows in any of `lists`, each once, in first-seen order. */
function union<T>(lists: T[][]): T[] {
  return [...new Set(lists.flat())];
}

/**
 * The chart's groups and their values. Groups come from groupRowsBy (so multi-select, people and
 * relation rows count in each of their groups) arranged like a board (saved order, hidden groups,
 * empty ones left out on request); the no-value group goes last and date axes get their empty
 * buckets. Sorting by value keeps groups without a value (an average of nothing) at the end.
 * Donuts fold everything past the 7 largest slices into "Other"; stacks do the same with series.
 */
export function chartData<T extends { properties: Record<string, unknown> }>(rows: T[], input: ChartInput): ChartData<T> {
  const { groupBy, measure, config } = input;
  const chartType = chartTypeOf(config);
  const settings = { groupDateBy: groupDateByOf(config), groupStatusBy: config.groupStatusBy };
  let grouped = groupRowsBy(rows, groupBy, settings, input.context);
  if (isDateLike(groupBy.type) && !config.hideEmptyGroups) grouped = fillDateGaps(grouped);
  const shown = noValueLast(arrangeGroups(grouped, config).shown, config.groupOrder);
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  if (accumulate) return accumulated(grouped, shown, measure, accumulate);

  let groups: ChartGroup<T>[] = shown.map((g, slot) => ({
    key: g.key,
    value: g.value,
    ...measured(g.rows, measure),
    slot,
    segments: [],
  }));

  const sort = chartSortOf(config);
  if (sort !== "group") {
    const sign = sort === "value_desc" ? -1 : 1;
    // Array.sort is stable: ties keep the grouping's order.
    groups = [...groups].sort((a, b) => {
      if (!a.result || !b.result) return (a.result ? 0 : 1) - (b.result ? 0 : 1);
      return sign * (a.amount - b.amount);
    });
  }

  if (chartType === "donut" && groups.length > MAX_CHART_SERIES) {
    const keep = new Set(
      [...groups]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, MAX_CHART_SERIES - 1)
        .map((g) => g.key),
    );
    const rest = groups.filter((g) => !keep.has(g.key));
    const kept = groups.filter((g) => keep.has(g.key));
    const slots = kept.map((g) => g.slot).sort((a, b) => a - b);
    groups = [
      ...kept.map((g) => ({ ...g, slot: slots.indexOf(g.slot) })),
      {
        key: OTHER_KEY,
        value: { kind: "none" },
        other: true,
        ...measured(union(rest.map((g) => g.rows)), measure),
        slot: MAX_CHART_SERIES - 1,
        segments: [],
      },
    ];
  }

  let series: ChartSeries[] = [];
  const stackBy = input.stackBy;
  if (stackBy && stackBy.id !== groupBy.id && isStackable(stackBy.type) && canStack(chartType, measure)) {
    const shownRows = union(groups.map((g) => g.rows));
    let stacks = noValueLast(groupRowsBy(shownRows, stackBy, {}, input.stackContext), undefined)
      .filter((s) => s.rows.length > 0)
      .map((s) => ({ key: s.key, value: s.value, rows: new Set(s.rows), total: measured(s.rows, measure).amount, other: false }));
    if (stacks.length > MAX_CHART_SERIES) {
      const keep = new Set(
        [...stacks]
          .sort((a, b) => b.total - a.total)
          .slice(0, MAX_CHART_SERIES - 1)
          .map((s) => s.key),
      );
      const rest = stacks.filter((s) => !keep.has(s.key));
      stacks = [
        ...stacks.filter((s) => keep.has(s.key)),
        { key: OTHER_KEY, value: { kind: "none" }, rows: new Set(rest.flatMap((s) => [...s.rows])), total: 0, other: true },
      ];
    }
    series = stacks.map((s, slot) => ({ key: s.key, value: s.value, ...(s.other ? { other: true } : {}), slot }));
    groups = groups.map((g) => ({
      ...g,
      segments: stacks.map((s) => ({ key: s.key, ...measured(g.rows.filter((r) => s.rows.has(r)), measure) })),
    }));
  }

  const totals = groups.map((g) => (g.segments.length ? g.segments.reduce((sum, s) => sum + s.amount, 0) : g.amount));
  return {
    groups,
    series,
    format: measureFormat(measure),
    min: Math.min(0, ...totals),
    max: Math.max(0, ...totals),
    total: measured(union(groups.map((g) => g.rows)), measure).amount,
  };
}

/**
 * Running totals over the shown periods, oldest first: each point measures the rows dated up to its
 * period ("cumulative"), or the rest of the chart's rows ("remaining"). Rows without a date are
 * never plotted and never taken away, whether or not the no-value group is shown: they are the
 * work still open. Hidden periods are left out altogether. Not sorted by value, not stacked.
 */
function accumulated<T extends { properties: Record<string, unknown> }>(
  grouped: Group<T>[],
  shown: Group<T>[],
  measure: ChartMeasure,
  mode: ChartAccumulate,
): ChartData<T> {
  const start = (g: Group<T>) => (g.value.kind === "date" ? g.value.start : "");
  const periods = shown.filter((g) => g.value.kind === "date").sort((a, b) => (start(a) < start(b) ? -1 : start(a) > start(b) ? 1 : 0));
  const undated = grouped.find((g) => g.value.kind === "none")?.rows ?? [];
  const all = union([...periods.map((g) => g.rows), undated]);
  const through = new Set<T>();
  const groups: ChartGroup<T>[] = periods.map((g, slot) => {
    for (const row of g.rows) through.add(row);
    const rows = mode === "cumulative" ? all.filter((r) => through.has(r)) : all.filter((r) => !through.has(r));
    const { amount } = measured(rows, measure);
    // Every period gets a value, so a line runs on through quiet ones.
    return { key: g.key, value: g.value, rows, result: { format: "number", value: amount }, amount, slot, segments: [], period: measured(g.rows, measure) };
  });
  const amounts = groups.map((g) => g.amount);
  return {
    groups,
    series: [],
    format: measureFormat(measure),
    min: Math.min(0, ...amounts),
    max: Math.max(0, ...amounts),
    total: measured(mode === "cumulative" ? all.filter((r) => through.has(r)) : all, measure).amount,
  };
}

/** The property a chart groups by: the saved one while it can group, else the one a board would take. */
export function chartGroupProperty<P extends { id: string; type: PropertyType }>(properties: P[], config: Pick<ViewConfig, "groupBy">) {
  return boardGroupProperty(properties, config.groupBy) ?? null;
}

/**
 * Evenly spaced round axis ticks covering `min`..`max` (about `count` of them): steps of 1, 2 or
 * 5 times a power of ten. Counts never get fractional steps.
 */
export function niceTicks(min: number, max: number, count = 5, integers = false): number[] {
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  let step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  if (integers) step = Math.max(1, Math.round(step));
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Rounding keeps 0.1 + 0.2 from printing as 0.30000000000000004.
  for (let i = 0, v = start; v <= end + step / 2 && i < 100; i++, v = start + i * step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import {
  canAccumulate,
  canStack,
  chartAccumulateOf,
  chartAggregateFunctions,
  chartData,
  chartGroupProperty,
  chartMeasure,
  fillDateGaps,
  isStackable,
  measureFormat,
  niceTicks,
  OTHER_KEY,
  type ChartInput,
  type ChartMeasure,
} from "./chart";
import { parseLinkedView, serializeLinkedView } from "./embed-blocks";
import { groupRowsBy } from "./grouping";
import { layoutConfigError } from "./views";

const prop = (type: PropertyType, options: PropertyOptions = {}, id = `p_${type}`) => ({ id, name: type, type, options });
const row = (id: string, properties: Record<string, unknown> = {}) => ({ id, properties });
type R = ReturnType<typeof row>;

const select = prop("select", {
  options: [
    { id: "o1", name: "Low", color: "gray" },
    { id: "o2", name: "High", color: "red" },
  ],
});
const tags = prop("multi_select", {
  options: [
    { id: "t1", name: "Bug", color: "red" },
    { id: "t2", name: "UI", color: "purple" },
  ],
});
const amount = prop("number");
const due = prop("date");
const done = prop("checkbox");
const COUNT: ChartMeasure = { kind: "count" };
const sum: ChartMeasure = { kind: "aggregate", fn: "sum", prop: { id: amount.id, type: "number", options: {} } };

const chart = (rows: R[], input: Partial<ChartInput> & { config?: ChartInput["config"] } = {}) =>
  chartData(rows, { groupBy: select, measure: COUNT, config: {}, ...input });
const keys = (data: { groups: { key: string }[] }) => data.groups.map((g) => g.key);
const amounts = (data: { groups: { amount: number }[] }) => data.groups.map((g) => g.amount);

const rows = [
  row("a", { p_select: "o2", p_number: 5, p_multi_select: ["t1", "t2"], p_checkbox: true }),
  row("b", { p_select: "o1", p_number: 2, p_multi_select: ["t1"] }),
  row("c", { p_select: "o2", p_number: 1 }),
  row("d", { p_number: 10, p_checkbox: true }),
];

describe("chartData", () => {
  it("counts rows per option, with the no-value group last", () => {
    const data = chart(rows);
    expect(keys(data)).toEqual(["o1", "o2", ""]);
    expect(amounts(data)).toEqual([1, 2, 1]);
    expect(data.groups[1].rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(data.format).toBe("number");
    expect(data).toMatchObject({ min: 0, max: 2, series: [] });
  });

  it("keeps the no-value group where the view placed it", () => {
    expect(keys(chart(rows, { config: { groupOrder: ["", "o2"] } }))).toEqual(["", "o2", "o1"]);
  });

  it("counts a multi-select row in each of its options", () => {
    const data = chart(rows, { groupBy: tags });
    expect(keys(data)).toEqual(["t1", "t2", ""]);
    expect(amounts(data)).toEqual([2, 1, 2]);
  });

  it("aggregates a number property per group", () => {
    const data = chart(rows, { measure: sum });
    expect(amounts(data)).toEqual([2, 6, 10]);
    const avg = chart(rows, { measure: { kind: "aggregate", fn: "average", prop: amount } });
    expect(amounts(avg)).toEqual([2, 3, 10]);
    expect(avg.groups[1].result).toEqual({ format: "number", value: 3 });
  });

  it("formats percentages and date ranges, and keeps groups without a value at 0", () => {
    const pct = chart(rows, { measure: { kind: "aggregate", fn: "percent_checked", prop: done } });
    expect(pct.format).toBe("percent");
    expect(amounts(pct)).toEqual([0, 0.5, 1]);
    const span = chart(
      [row("a", { p_select: "o1", p_date: "2026-01-01" }), row("b", { p_select: "o1", p_date: "2026-01-11" }), row("c", { p_select: "o2" })],
      { measure: { kind: "aggregate", fn: "date_range", prop: due } },
    );
    expect(span.format).toBe("days");
    expect(span.groups.map((g) => g.result)).toEqual([{ format: "days", value: 10 }, null]);
    expect(amounts(span)).toEqual([10, 0]);
  });

  it("leaves out empty and hidden groups on request", () => {
    const few = [row("a", { p_select: "o2" })];
    expect(keys(chart(few))).toEqual(["o1", "o2"]);
    expect(keys(chart(few, { config: { hideEmptyGroups: true } }))).toEqual(["o2"]);
    expect(keys(chart(rows, { config: { hiddenGroups: ["", "o1"] } }))).toEqual(["o2"]);
  });

  it("sorts groups by value, keeping ties in group order and groups without a value last", () => {
    const sorted = chart(rows, { config: { chartSort: "value_desc" } });
    expect(keys(sorted)).toEqual(["o2", "o1", ""]);
    // Colors follow the group, not its rank.
    expect(sorted.groups.map((g) => g.slot)).toEqual([1, 0, 2]);
    expect(keys(chart(rows, { config: { chartSort: "value_asc" } }))).toEqual(["o1", "", "o2"]);
    const avg: ChartMeasure = { kind: "aggregate", fn: "average", prop: amount };
    const sparse = [row("a", { p_select: "o1", p_number: 3 }), row("b", { p_select: "o2" }), row("c", { p_number: 1 })];
    expect(keys(chart(sparse, { measure: avg, config: { chartSort: "value_asc" } }))).toEqual(["", "o1", "o2"]);
    expect(keys(chart(sparse, { measure: avg, config: { chartSort: "value_desc" } }))).toEqual(["o1", "", "o2"]);
  });

  it("groups dates by month with the quiet months in between, unless empty groups are hidden", () => {
    const dated = [row("a", { p_date: "2026-01-15" }), row("b", { p_date: "2026-04-02" }), row("c", { p_date: "2026-01-20" }), row("d")];
    const data = chart(dated, { groupBy: due, config: { chartType: "line" } });
    expect(keys(data)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", ""]);
    expect(amounts(data)).toEqual([2, 0, 0, 1, 1]);
    expect(data.groups[1].value).toEqual({ kind: "date", by: "month", start: "2026-02-01", end: "2026-02-28" });
    expect(keys(chart(dated, { groupBy: due, config: { hideEmptyGroups: true } }))).toEqual(["2026-01-01", "2026-04-01", ""]);
    const weeks = chart(dated, { groupBy: due, config: { groupDateBy: "year" } });
    expect(keys(weeks)).toEqual(["2026-01-01", ""]);
  });

  it("stacks bars by a second property, each segment measured on its own", () => {
    const data = chart(rows, { stackBy: done, measure: sum });
    expect(data.series.map((s) => s.key)).toEqual(["false", "true"]);
    expect(data.groups.map((g) => g.segments.map((s) => s.amount))).toEqual([
      [2, 0],
      [1, 5],
      [0, 10],
    ]);
    expect(data.groups[1].segments[1].rows.map((r) => r.id)).toEqual(["a"]);
    expect(data.max).toBe(10);
  });

  it("stacks only bars, only by another property and only measures that add up", () => {
    const avg: ChartMeasure = { kind: "aggregate", fn: "average", prop: amount };
    expect(chart(rows, { stackBy: done, measure: avg }).series).toEqual([]);
    expect(chart(rows, { stackBy: done, config: { chartType: "line" } }).series).toEqual([]);
    expect(chart(rows, { stackBy: select }).series).toEqual([]);
    expect(canStack("horizontal_bar", COUNT)).toBe(true);
    expect(canStack("bar", { kind: "aggregate", fn: "count_values", prop: tags })).toBe(true);
    expect(canStack("bar", { kind: "aggregate", fn: "percent_empty", prop: tags })).toBe(false);
    expect(canStack("donut", COUNT)).toBe(false);
  });

  it("stacks only the series the shown bars have, and totals them for the axis", () => {
    const size = prop("select", { options: ["s1", "s2", "s3"].map((id) => ({ id, name: id, color: "gray" })) }, "p_size");
    const sized = [
      row("a", { p_select: "o2", p_size: "s1" }),
      row("b", { p_select: "o1", p_size: "s2" }),
      row("c", { p_select: "o2" }),
      // Only in the hidden no-value bar: s3 isn't a series.
      row("d", { p_size: "s3" }),
    ];
    const data = chart(sized, { stackBy: size, config: { hiddenGroups: [""] } });
    expect(data.series.map((s) => s.key)).toEqual(["s1", "s2", ""]);
    expect(data.groups.map((g) => g.segments.map((s) => s.amount))).toEqual([
      [0, 1, 0],
      [1, 0, 1],
    ]);
    expect(data.max).toBe(2);
  });

  it("totals every row once, though a row with two tags is in two groups", () => {
    const data = chart(rows, { groupBy: tags, config: { chartType: "donut" } });
    expect(amounts(data)).toEqual([2, 1, 2]);
    expect(data.total).toBe(4);
    expect(chart(rows, { groupBy: tags, measure: sum }).total).toBe(18);
  });

  it("doesn't stack by properties that hold several values, whose rows would count in several segments", () => {
    expect(chart(rows, { stackBy: tags }).series).toEqual([]);
    expect(chart(rows, { stackBy: prop("person") }).series).toEqual([]);
    expect(chart(rows, { stackBy: prop("relation") }).series).toEqual([]);
    expect(isStackable("status") && isStackable("checkbox") && isStackable("created_by")).toBe(true);
    expect(isStackable("multi_select") || isStackable("text")).toBe(false);
  });

  it("folds donut slices past the seven largest into Other", () => {
    const many = prop("select", { options: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, name: `O${i}`, color: "gray" })) }, "p_many");
    const lots = Array.from({ length: 10 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => row(`r${i}-${j}`, { p_many: `o${i}` }))).flat();
    const data = chart(lots, { groupBy: many, config: { chartType: "donut" } });
    expect(keys(data)).toEqual(["o3", "o4", "o5", "o6", "o7", "o8", "o9", OTHER_KEY]);
    const other = data.groups.at(-1)!;
    expect(other.other).toBe(true);
    expect(other.amount).toBe(1 + 2 + 3);
    expect(other.rows).toHaveLength(6);
    expect(data.groups.map((g) => g.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(keys(chart(lots, { groupBy: many }))).toHaveLength(10);
  });

  it("puts negative sums below the baseline", () => {
    const data = chart([row("a", { p_select: "o1", p_number: -4 }), row("b", { p_select: "o2", p_number: 3 })], { measure: sum });
    expect(data).toMatchObject({ min: -4, max: 3 });
  });
});

describe("chartData with running totals", () => {
  // Two rows done the week of Aug 31, none the week after, one the week of Sep 14, two still open.
  const work = [
    row("a", { p_date: "2026-09-01", p_number: 3, p_select: "o1" }),
    row("b", { p_date: "2026-09-02", p_number: 2, p_select: "o2" }),
    row("c", { p_date: "2026-09-16", p_number: 5, p_select: "o2" }),
    row("d", { p_number: 4 }),
    row("e", { p_number: 1 }),
  ];
  const weekly = (accumulate: "cumulative" | "remaining", config: ChartInput["config"] = {}, input: Partial<ChartInput> = {}) =>
    chart(work, { groupBy: due, config: { groupDateBy: "week", chartAccumulate: accumulate, ...config }, ...input });
  const ids = (data: { groups: { rows: R[] }[] }) => data.groups.map((g) => g.rows.map((r) => r.id).join(""));

  it("adds each period to the ones before it, quiet periods included", () => {
    const data = weekly("cumulative");
    expect(keys(data)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(amounts(data)).toEqual([2, 2, 3]);
    expect(ids(data)).toEqual(["ab", "ab", "abc"]);
    expect(data.groups.map((g) => g.period?.amount)).toEqual([2, 0, 1]);
    expect(data.total).toBe(3);
  });

  it("takes each period away from the whole, rows without a date staying open", () => {
    const data = weekly("remaining");
    expect(amounts(data)).toEqual([3, 3, 2]);
    expect(ids(data)).toEqual(["cde", "cde", "de"]);
    expect(data.total).toBe(5);
    expect(data.max).toBe(3);
  });

  it("runs sums too, with a value in every period so a line doesn't break", () => {
    expect(amounts(weekly("cumulative", {}, { measure: sum }))).toEqual([5, 5, 10]);
    const remaining = weekly("remaining", {}, { measure: sum });
    expect(amounts(remaining)).toEqual([10, 10, 5]);
    expect(remaining.groups.every((g) => g.result !== null)).toBe(true);
  });

  it("keeps rows without a date in the burndown whether or not their group is shown", () => {
    expect(amounts(weekly("remaining", { hiddenGroups: [""] }))).toEqual([3, 3, 2]);
    expect(keys(weekly("remaining"))).not.toContain("");
  });

  it("leaves hidden periods out altogether", () => {
    const data = weekly("remaining", { hiddenGroups: ["2026-09-14"] });
    expect(keys(data)).toEqual(["2026-08-31", "2026-09-07"]);
    expect(amounts(data)).toEqual([2, 2]);
    expect(data.total).toBe(4);
  });

  it("runs oldest first and unstacked, whatever the sort and stack settings say", () => {
    const data = weekly("cumulative", { chartSort: "value_desc", groupOrder: ["2026-09-14"] }, { stackBy: select });
    expect(keys(data)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(data.series).toEqual([]);
  });

  it("plots each period on its own where totals can't run", () => {
    const average: ChartMeasure = { kind: "aggregate", fn: "average", prop: { id: amount.id, type: "number", options: {} } };
    expect(amounts(weekly("cumulative", { chartType: "donut" }))).toEqual([2, 0, 1, 2]);
    expect(weekly("cumulative", {}, { measure: average }).groups[0].period).toBeUndefined();
    expect(chart(work, { config: { chartAccumulate: "remaining" } }).groups[0].period).toBeUndefined();
  });
});

describe("chartAccumulateOf", () => {
  it("needs a date or time axis, a measure that adds up and bars or a line", () => {
    const config = { chartAccumulate: "remaining" as const };
    expect(chartAccumulateOf(config, due, COUNT)).toBe("remaining");
    expect(chartAccumulateOf(config, prop("created_time"), sum)).toBe("remaining");
    expect(chartAccumulateOf({ ...config, chartType: "line" }, due, COUNT)).toBe("remaining");
    expect(chartAccumulateOf({ ...config, chartType: "donut" }, due, COUNT)).toBeNull();
    expect(chartAccumulateOf(config, select, COUNT)).toBeNull();
    expect(chartAccumulateOf(config, null, COUNT)).toBeNull();
    expect(chartAccumulateOf({ chartAccumulate: "sideways" as never }, due, COUNT)).toBeNull();
    expect(chartAccumulateOf({}, due, COUNT)).toBeNull();
    expect(canAccumulate("bar", due, { kind: "aggregate", fn: "percent_empty", prop: { id: "x", type: "text", options: {} } })).toBe(false);
  });
});

describe("fillDateGaps", () => {
  it("fills weeks from Monday and leaves long spans alone", () => {
    const weekly = groupRowsBy([row("a", { p_date: "2026-09-02" }), row("b", { p_date: "2026-09-23" })], due, { groupDateBy: "week" });
    expect(fillDateGaps(weekly).map((g) => g.key)).toEqual(["", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
    const daily = groupRowsBy([row("a", { p_date: "2020-01-01" }), row("b", { p_date: "2026-01-01" })], due, { groupDateBy: "day" });
    expect(fillDateGaps(daily)).toBe(daily);
  });
});

describe("chartMeasure", () => {
  const props = [amount, select, due];
  it("counts rows unless a valid calculation is set", () => {
    expect(chartMeasure({}, props)).toEqual(COUNT);
    expect(chartMeasure({ chartAggregate: { fn: "sum", propertyId: "p_number" } }, props)).toEqual(sum);
    expect(chartMeasure({ chartAggregate: { fn: "sum", propertyId: "gone" } }, props)).toEqual(COUNT);
    expect(chartMeasure({ chartAggregate: { fn: "sum", propertyId: "p_select" } }, props)).toEqual(COUNT);
    expect(chartMeasure({ chartAggregate: { fn: "latest_date", propertyId: "p_date" } }, props)).toEqual(COUNT);
  });

  it("measures formulas and rollups like their result type, skipping rows where a formula failed", () => {
    const total = prop("formula", { formula: { expression: "1", type: "number" } }, "p_total");
    const label = prop("formula", { formula: { expression: '"x"', type: "text" } }, "p_label");
    const spent = prop("rollup", { rollup: { relationPropertyId: "r", targetPropertyId: "t", function: "sum" } }, "p_spent");
    const measure = chartMeasure({ chartAggregate: { fn: "sum", propertyId: "p_total" } }, [total]);
    expect(measure).toEqual({ kind: "aggregate", fn: "sum", prop: { id: "p_total", type: "number", options: total.options } });
    expect(chartMeasure({ chartAggregate: { fn: "sum", propertyId: "p_label" } }, [label])).toEqual(COUNT);
    expect(chartMeasure({ chartAggregate: { fn: "average", propertyId: "p_spent" } }, [spent]).kind).toBe("aggregate");
    const data = chart(
      [row("a", { p_select: "o1", p_total: 4 }), row("b", { p_select: "o1", p_total: { error: { code: "divide" } } }), row("c", { p_select: "o1", p_total: 1 })],
      { measure, config: { hideEmptyGroups: true } },
    );
    expect(amounts(data)).toEqual([5]);
  });

  it("offers each type's calculations, without the ones a chart can't plot", () => {
    expect(chartAggregateFunctions("number")).toEqual([
      "count_values",
      "count_unique",
      "count_empty",
      "count_not_empty",
      "percent_empty",
      "percent_not_empty",
      "sum",
      "average",
      "median",
      "min",
      "max",
      "range",
    ]);
    expect(chartAggregateFunctions("date")).not.toContain("earliest_date");
    expect(chartAggregateFunctions("date")).toContain("date_range");
    expect(chartAggregateFunctions("checkbox")).toEqual(["count_checked", "count_unchecked", "percent_checked", "percent_unchecked"]);
    expect(measureFormat({ kind: "aggregate", fn: "percent_not_empty", prop: amount })).toBe("percent");
  });

  it("groups by the property a board would take", () => {
    expect(chartGroupProperty([amount, due, select], {})?.id).toBe("p_select");
    expect(chartGroupProperty([amount, due, select], { groupBy: "p_date" })?.id).toBe("p_date");
    expect(chartGroupProperty([amount, due, select], { groupBy: "p_number" })?.id).toBe("p_select");
    expect(chartGroupProperty([amount], {})).toBeNull();
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten", () => {
    expect(niceTicks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0, 7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0, 1340)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(-4, 3)).toEqual([-4, -2, 0, 2, 4]);
    expect(niceTicks(0, 0.75)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it("never splits counts into fractions, and survives an empty chart", () => {
    expect(niceTicks(0, 2, 5, true)).toEqual([0, 1, 2]);
    expect(niceTicks(0, 0, 5, true)).toEqual([0, 1]);
  });
});

describe("layoutConfigError for charts", () => {
  const error = (config: object) => layoutConfigError(config as ViewConfig);
  it("accepts chart settings", () => {
    expect(
      error({
        chartType: "donut",
        chartSort: "value_desc",
        chartAccumulate: "remaining",
        chartAggregate: { fn: "sum", propertyId: "p" },
        stackBy: "s",
        showValues: true,
        showLegend: false,
        hiddenGroups: [""],
        groupOrder: ["a"],
      }),
    ).toBeNull();
  });

  it.each([
    ["chart type", { chartType: "pie" }],
    ["sort", { chartSort: "random" }],
    ["running total", { chartAccumulate: "burnup" }],
    ["aggregate shape", { chartAggregate: "sum" }],
    ["aggregate property", { chartAggregate: { fn: "sum" } }],
    ["aggregate function", { chartAggregate: { fn: "latest_date", propertyId: "p" } }],
    ["unknown function", { chartAggregate: { fn: "mode", propertyId: "p" } }],
    ["stack property", { stackBy: 3 }],
    ["value labels", { showValues: "yes" }],
    ["legend", { showLegend: 1 }],
    ["hidden groups", { hiddenGroups: "a" }],
    ["group order", { groupOrder: [1] }],
  ])("refuses a malformed %s", (_, config) => {
    expect(error(config)).toBeTruthy();
  });
});

describe("a linked chart view", () => {
  it("keeps its chart settings", () => {
    const view = {
      type: "chart" as const,
      config: {
        groupBy: "p",
        chartType: "donut" as const,
        chartAggregate: { fn: "sum" as const, propertyId: "n" },
        chartAccumulate: "remaining" as const,
        showLegend: true,
      },
    };
    expect(parseLinkedView(serializeLinkedView(view))).toEqual(view);
  });

  it("reads malformed chart settings as none", () => {
    expect(parseLinkedView(JSON.stringify({ type: "chart", config: { chartType: "radar" } }))).toEqual({ type: "chart", config: {} });
  });
});

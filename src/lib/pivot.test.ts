import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import { groupRowsBy } from "./grouping";
import { pivotColumnProperty, pivotData, pivotMeasure, pivotRowProperty, withoutPivotRows } from "./pivot";

type Prop = { id: string; type: PropertyType; options: PropertyOptions; name: string };

const customer: Prop = {
  id: "customer",
  name: "Customer",
  type: "select",
  options: {
    options: [
      { id: "acme", name: "Acme", color: "blue" },
      { id: "beta", name: "Beta", color: "green" },
      { id: "gamma", name: "Gamma", color: "red" },
    ],
  },
};
const amount: Prop = { id: "amount", name: "Amount", type: "number", options: { number: { format: "currency", currency: "TRY" } as never } };
const date: Prop = { id: "date", name: "Date", type: "date", options: {} };
const tags: Prop = {
  id: "tags",
  name: "Tags",
  type: "multi_select",
  options: { options: [{ id: "a", name: "A", color: "blue" }, { id: "b", name: "B", color: "red" }] },
};
const city: Prop = { id: "city", name: "City", type: "text", options: {} };
const properties = [customer, amount, date, tags, city];

const row = (id: string, properties: Record<string, unknown>) => ({ id, properties });
const rows = [
  row("1", { customer: "acme", amount: 100.1, date: "2026-01-05", tags: ["a"], city: "İzmir" }),
  row("2", { customer: "acme", amount: 200.2, date: "2026-02-10", tags: ["a", "b"], city: "Ankara" }),
  row("3", { customer: "beta", amount: 50, date: "2026-01-20", tags: [], city: " Ankara " }),
  row("4", { customer: "acme", amount: 0.1, date: "2026-01-31", city: "" }),
  row("5", { amount: 10, date: "2026-03-01" }),
];

const sum = { chartAggregate: { fn: "sum" as const, propertyId: "amount" } };

describe("pivotData", () => {
  it("measures each cell, and totals over the rows they cover", () => {
    const data = pivotData(rows, { rowBy: customer, columnBy: date, measure: pivotMeasure(sum, properties), config: {} });
    expect(data.columns.map((c) => c.key)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    // Rows without a customer go last; Gamma has no rows but shows until empty groups are hidden.
    expect(data.rows.map((r) => r.key)).toEqual(["acme", "beta", "gamma", ""]);
    const acme = data.rows[0];
    // 100.1 + 0.1 keeps one decimal, as a table footer's sum does.
    expect(acme.cells.map((c) => c.result?.value ?? null)).toEqual([100.2, 200.2, 0]);
    expect(acme.total.result).toEqual({ format: "number", value: 300.4 });
    expect(data.columns[0].total.result).toEqual({ format: "number", value: 150.2 });
    expect(data.grand.result).toEqual({ format: "number", value: 360.4 });
  });

  it("hides empty groups on both axes and sorts by value", () => {
    const data = pivotData(rows, {
      rowBy: customer,
      columnBy: date,
      measure: pivotMeasure(sum, properties),
      config: { hideEmptyGroups: true, chartSort: "value_asc", columnSort: "value_desc" },
    });
    expect(data.rows.map((r) => r.key)).toEqual(["", "beta", "acme"]);
    expect(data.columns.map((c) => c.key)).toEqual(["2026-02-01", "2026-01-01", "2026-03-01"]);
  });

  it("counts a row in each of its tags but once in a total", () => {
    const data = pivotData(rows, { rowBy: customer, columnBy: tags, measure: { kind: "count" }, config: { hideEmptyGroups: true } });
    expect(data.columns.map((c) => c.key)).toEqual(["a", "b", ""]);
    const acme = data.rows.find((r) => r.key === "acme")!;
    expect(acme.cells.map((c) => c.rows.length)).toEqual([2, 1, 1]);
    expect(acme.total.result?.value).toBe(3);
    expect(data.grand.result?.value).toBe(5);
  });

  it("averages a total over its rows, not over its cells", () => {
    const average = { chartAggregate: { fn: "average" as const, propertyId: "amount" } };
    const data = pivotData(rows.slice(0, 3), { rowBy: date, columnBy: customer, measure: pivotMeasure(average, properties), config: { groupDateBy: "quarter" } });
    expect(data.rows.map((r) => r.key)).toEqual(["2026-01-01"]);
    expect(data.rows[0].total.result?.value).toBeCloseTo((100.1 + 200.2 + 50) / 3);
  });

  it("shows only totals without a column property", () => {
    const data = pivotData(rows, { rowBy: customer, columnBy: null, measure: { kind: "count" }, config: { hideEmptyGroups: true } });
    expect(data.columns).toEqual([]);
    expect(data.rows.map((r) => [r.key, r.total.result?.value])).toEqual([
      ["acme", 3],
      ["beta", 1],
      ["", 1],
    ]);
  });

  it("sends counts instead of rows", () => {
    const data = withoutPivotRows(pivotData(rows, { rowBy: customer, columnBy: date, measure: { kind: "count" }, config: {} }));
    expect(data.rows[0].cells[0]).toEqual({ rows: [], result: { format: "number", value: 2 }, amount: 2, count: 2 });
  });
});

describe("pivot rows by text", () => {
  it("groups text by its trimmed value, in alphabetical order", () => {
    const groups = groupRowsBy(rows, city);
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["", ["4", "5"]],
      ["Ankara", ["2", "3"]],
      ["İzmir", ["1"]],
    ]);
  });
});

describe("pivot properties", () => {
  it("falls back for rows and drops a column property that can't group or is the rows'", () => {
    expect(pivotRowProperty(properties, { groupBy: "gone" })?.id).toBe("customer");
    expect(pivotRowProperty(properties, { groupBy: "city" })?.id).toBe("city");
    expect(pivotRowProperty(properties, { groupBy: "amount" })?.id).toBe("amount");
    expect(pivotColumnProperty(properties, { columnBy: "gone" }, customer)).toBeNull();
    expect(pivotColumnProperty(properties, { columnBy: "amount" }, customer)?.id).toBe("amount");
    expect(pivotColumnProperty(properties, { columnBy: "customer" }, customer)).toBeNull();
    expect(pivotColumnProperty(properties, { columnBy: "date" }, customer)?.id).toBe("date");
  });

  it("counts rows unless a number calculation is set", () => {
    expect(pivotMeasure({ chartAggregate: { fn: "count_values", propertyId: "amount" } }, properties)).toEqual({ kind: "count" });
    expect(pivotMeasure({ chartAggregate: { fn: "sum", propertyId: "customer" } }, properties)).toEqual({ kind: "count" });
    expect(pivotMeasure(sum, properties).kind).toBe("aggregate");
  });
});

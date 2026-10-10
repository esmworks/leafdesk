import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateFunctions,
  aggregateGroup,
  aggregateValues,
  AGGREGATE_FNS,
  isAggregateFn,
  isApplicable,
  valueKind,
  type AggregateFn,
} from "./aggregate";
import type { RowLike } from "./properties";

const status = {
  type: "select",
  options: {
    options: [
      { id: "o1", name: "Todo", color: "gray" },
      { id: "o2", name: "Done", color: "green" },
    ],
  },
};
const tags = {
  type: "multi_select",
  options: {
    options: [
      { id: "t1", name: "Bug", color: "red" },
      { id: "t2", name: "UI", color: "blue" },
    ],
  },
};

const num = (value: number) => ({ format: "number", value });
const pct = (value: number) => ({ format: "percent", value });
const run = (values: unknown[], fn: AggregateFn, type: string, options?: typeof status.options) =>
  aggregateValues(values, fn, { type, options });

describe("valueKind", () => {
  it("maps property types and special columns to kinds", () => {
    expect(valueKind("title")).toBe("text");
    expect(valueKind("url")).toBe("text");
    expect(valueKind("number")).toBe("number");
    expect(valueKind("date")).toBe("date");
    expect(valueKind("created_at")).toBe("date");
    expect(valueKind("checkbox")).toBe("checkbox");
    expect(valueKind("select")).toBe("options");
    expect(valueKind("multi_select")).toBe("options");
    expect(valueKind("person")).toBe("people");
    expect(valueKind("created_by")).toBe("people");
    expect(valueKind("relation")).toBe("relation");
    expect(valueKind("status")).toBe("options");
    expect(valueKind("email")).toBe("text");
    expect(valueKind("last_edited_time")).toBe("date");
    expect(valueKind("last_edited_by")).toBe("people");
    expect(valueKind("checklist")).toBe("checklist");
  });

  it("falls back to other for unknown types, including Object prototype names", () => {
    expect(valueKind("hologram")).toBe("other");
    expect(valueKind("toString")).toBe("other");
    expect(valueKind("constructor")).toBe("other");
  });
});

describe("aggregateFunctions", () => {
  it("offers the generic counts everywhere except checkboxes", () => {
    for (const type of ["text", "select", "person", "relation", "hologram"]) {
      expect(aggregateFunctions(type)).toEqual([
        "count_all",
        "count_values",
        "count_unique",
        "count_empty",
        "count_not_empty",
        "percent_empty",
        "percent_not_empty",
      ]);
    }
  });

  it("adds number, date and checkbox calculations by kind", () => {
    expect(aggregateFunctions("number")).toEqual(expect.arrayContaining(["sum", "average", "median", "min", "max", "range"]));
    expect(aggregateFunctions("date")).toEqual(expect.arrayContaining(["earliest_date", "latest_date", "date_range"]));
    expect(aggregateFunctions("checkbox")).toEqual([
      "count_all",
      "count_checked",
      "count_unchecked",
      "percent_checked",
      "percent_unchecked",
    ]);
    expect(isApplicable("sum", "text")).toBe(false);
    expect(isApplicable("sum", "number")).toBe(true);
    expect(isApplicable("count_empty", "checkbox")).toBe(false);
  });

  it("every function is offered somewhere and belongs to a menu group", () => {
    const offered = new Set(["text", "number", "date", "checkbox"].flatMap(aggregateFunctions));
    for (const fn of AGGREGATE_FNS) {
      expect(offered.has(fn)).toBe(true);
      expect(["count", "percent", "kind"]).toContain(aggregateGroup(fn));
    }
    expect(aggregateGroup("count_unique")).toBe("count");
    expect(aggregateGroup("percent_empty")).toBe("percent");
    expect(aggregateGroup("percent_checked")).toBe("kind");
  });

  it("recognises stored function names", () => {
    expect(isAggregateFn("sum")).toBe(true);
    expect(isAggregateFn("SUM")).toBe(false);
    expect(isAggregateFn(undefined)).toBe(false);
  });
});

describe("aggregateValues: generic counts", () => {
  const text = ["a", "", null, "b", "a", undefined];

  it("counts rows, values, unique values and empties", () => {
    expect(run(text, "count_all", "text")).toEqual(num(6));
    expect(run(text, "count_values", "text")).toEqual(num(3));
    expect(run(text, "count_unique", "text")).toEqual(num(2));
    expect(run(text, "count_empty", "text")).toEqual(num(3));
    expect(run(text, "count_not_empty", "text")).toEqual(num(3));
  });

  it("gives percentages as fractions", () => {
    expect(run(text, "percent_empty", "text")).toEqual(pct(0.5));
    expect(run(text, "percent_not_empty", "text")).toEqual(pct(0.5));
  });

  it("handles no rows: zero counts, no percentage", () => {
    expect(run([], "count_all", "text")).toEqual(num(0));
    expect(run([], "count_unique", "text")).toEqual(num(0));
    expect(run([], "percent_empty", "text")).toBeNull();
    expect(run([], "percent_checked", "checkbox")).toBeNull();
  });

  it("counts every item of list values, and unique items across rows", () => {
    const values = [["t1", "t2"], ["t1"], [], null];
    expect(run(values, "count_values", "multi_select", tags.options)).toEqual(num(3));
    expect(run(values, "count_unique", "multi_select", tags.options)).toEqual(num(2));
    expect(run(values, "count_not_empty", "multi_select", tags.options)).toEqual(num(2));
    const people = [["u1", "u2"], ["u2"], null];
    expect(run(people, "count_values", "person")).toEqual(num(3));
    expect(run(people, "count_unique", "person")).toEqual(num(2));
    expect(run([["r1"], [], ["r1", "r2"]], "count_unique", "relation")).toEqual(num(2));
  });

  it("ignores ids of deleted options, like the cells do", () => {
    expect(run(["o1", "gone", null, "o2", "o1"], "count_empty", "select", status.options)).toEqual(num(2));
    expect(run(["o1", "gone", null, "o2", "o1"], "count_unique", "select", status.options)).toEqual(num(2));
    expect(run([["t1", "gone"], ["gone"]], "count_values", "multi_select", tags.options)).toEqual(num(1));
    expect(run([["t1", "gone"], ["gone"]], "percent_empty", "multi_select", tags.options)).toEqual(pct(0.5));
    // Without the property's options every id is unknown.
    expect(run(["o1"], "count_not_empty", "select")).toEqual(num(0));
  });

  it("counts unknown types generically", () => {
    expect(run([{ a: 1 }, { a: 1 }, null, [1]], "count_unique", "hologram")).toEqual(num(2));
    expect(run([{ a: 1 }, null], "count_empty", "hologram")).toEqual(num(1));
    expect(run([1, 2], "sum", "hologram")).toBeNull();
  });

  it("returns null for a function the type doesn't offer", () => {
    expect(run(["1", "2"], "sum", "text")).toBeNull();
    expect(run([true], "count_empty", "checkbox")).toBeNull();
    expect(run(["2024-01-01"], "average", "date")).toBeNull();
  });
});

describe("aggregateValues: numbers", () => {
  const values = [3, null, 1, 10, 4, Number.NaN, "7"];

  it("sums, averages and finds the middle over numbers only", () => {
    expect(run(values, "sum", "number")).toEqual(num(18));
    expect(run(values, "average", "number")).toEqual(num(4.5));
    expect(run(values, "median", "number")).toEqual(num(3.5));
    expect(run([5, 1, 3], "median", "number")).toEqual(num(3));
    expect(run(values, "min", "number")).toEqual(num(1));
    expect(run(values, "max", "number")).toEqual(num(10));
    expect(run(values, "range", "number")).toEqual(num(9));
    expect(run([-2, -5], "max", "number")).toEqual(num(-2));
  });

  it("treats non-numbers as empty", () => {
    expect(run(values, "count_empty", "number")).toEqual(num(3));
    expect(run([0, 0, 1], "count_unique", "number")).toEqual(num(2));
    expect(run([0], "count_not_empty", "number")).toEqual(num(1));
  });

  it("sums nothing to zero and leaves the rest blank", () => {
    expect(run([], "sum", "number")).toEqual(num(0));
    expect(run([null], "sum", "number")).toEqual(num(0));
    for (const fn of ["average", "median", "min", "max", "range"] as const) expect(run([null], fn, "number")).toBeNull();
  });
});

describe("aggregateValues: dates", () => {
  const values = ["2024-03-10", null, "2024-01-31", "2024-12-01", "not a date", "2024-01-31"];

  it("finds the earliest and latest date and the days between them", () => {
    expect(run(values, "earliest_date", "date")).toEqual({ format: "date", value: "2024-01-31" });
    expect(run(values, "latest_date", "date")).toEqual({ format: "date", value: "2024-12-01" });
    expect(run(values, "date_range", "date")).toEqual({ format: "days", value: 305 });
    expect(run(["2024-05-05"], "date_range", "date")).toEqual({ format: "days", value: 0 });
  });

  it("counts unparseable dates as empty and has no result without dates", () => {
    expect(run(values, "count_empty", "date")).toEqual(num(2));
    expect(run(values, "count_unique", "date")).toEqual(num(3));
    expect(run([null], "earliest_date", "date")).toBeNull();
    expect(run([], "date_range", "date")).toBeNull();
  });

  it("counts ranges from their first start to their last end", () => {
    const ranges = ["2024-03-10/2024-03-20", "2024-03-01", "2024-03-05T10:00:00.000Z/2024-03-25T10:00:00.000Z"];
    expect(run(ranges, "earliest_date", "date")).toEqual({ format: "date", value: "2024-03-01" });
    expect(run(ranges, "latest_date", "date")).toEqual({ format: "date", value: "2024-03-25T10:00:00.000Z" });
    expect(run(["2024-03-10/2024-03-20"], "date_range", "date")).toEqual({ format: "days", value: 10 });
    expect(run(ranges, "count_values", "date")).toEqual(num(3));
  });

  it("orders timestamps and plain dates together", () => {
    const mixed = ["2024-01-02", "2024-01-01T23:00:00.000Z", "2024-01-01T01:00:00.000Z"];
    expect(run(mixed, "earliest_date", "created_time")).toEqual({ format: "date", value: "2024-01-01T01:00:00.000Z" });
    expect(run(mixed, "latest_date", "created_time")).toEqual({ format: "date", value: "2024-01-02" });
  });
});

describe("aggregateValues: checklists", () => {
  const item = (text: string, checked = false) => ({ id: text, text, checked });
  const values = [[item("Draft", true), item("Review")], [], null, [item("Draft")]];

  it("counts items by their text and empty checklists as empty", () => {
    expect(run(values, "count_values", "checklist")).toEqual(num(3));
    expect(run(values, "count_unique", "checklist")).toEqual(num(2));
    expect(run(values, "count_empty", "checklist")).toEqual(num(2));
    expect(run(values, "percent_not_empty", "checklist")).toEqual(pct(0.5));
  });

  it("only offers the generic counts", () => {
    expect(aggregateFunctions("checklist")).not.toContain("count_checked");
    expect(run(values, "sum", "checklist")).toBeNull();
  });
});

describe("aggregateValues: checkboxes", () => {
  const values = [true, false, null, true, undefined];

  it("counts unchecked (false or never set) and checked boxes", () => {
    expect(run(values, "count_all", "checkbox")).toEqual(num(5));
    expect(run(values, "count_checked", "checkbox")).toEqual(num(2));
    expect(run(values, "count_unchecked", "checkbox")).toEqual(num(3));
    expect(run(values, "percent_checked", "checkbox")).toEqual(pct(0.4));
    expect(run(values, "percent_unchecked", "checkbox")).toEqual(pct(0.6));
  });
});

describe("aggregate over rows", () => {
  const at = new Date("2024-06-01T12:00:00Z");
  const row = (id: string, title: string, properties: Record<string, unknown>, createdAt = at): RowLike => ({
    id,
    title,
    properties,
    createdAt,
    updatedAt: createdAt,
  });
  const rows = [
    row("a", "Alpha", { n: 2, s: "o1" }),
    row("b", "", { n: 5, s: "gone" }, new Date("2024-01-01T00:00:00Z")),
    row("c", "Gamma", {}),
  ];

  it("reads a property column", () => {
    expect(aggregate(rows, "n", "sum", { type: "number" })).toEqual(num(7));
    expect(aggregate(rows, "s", "count_not_empty", status)).toEqual(num(1));
  });

  it("reads the title and the row's own times", () => {
    expect(aggregate(rows, "title", "count_empty")).toEqual(num(1));
    expect(aggregate(rows, "created_at", "earliest_date")).toEqual({ format: "date", value: "2024-01-01T00:00:00.000Z" });
  });

  it("counts a column without a known property generically", () => {
    expect(aggregate(rows, "n", "count_not_empty")).toEqual(num(2));
    expect(aggregate(rows, "n", "sum")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType, RollupConfig } from "@/db/schema/app";
import { rollupFunctions } from "./aggregate";
import { derivedType, isErrorValue, valueType, withFormulas } from "./derived";
import { planDuplicate } from "./duplicate";
import { applyView } from "./properties";
import { resolveRollup, rollupValue, type RelatedRow, type ResolvedRollup } from "./rollup";

type P = { id: string; name: string; type: PropertyType; options: PropertyOptions };
const prop = (id: string, name: string, type: PropertyType, options: PropertyOptions = {}): P => ({ id, name, type, options });
const rollup = (id: string, config: Partial<RollupConfig>): P =>
  prop(id, id, "rollup", { rollup: { relationPropertyId: "rel", targetPropertyId: "title", function: "count_all", ...config } });

const NOW = new Date("2026-09-27T12:00:00Z");

// Projects link to tasks. Tasks: t1..t4; t4 is one the viewer can't see (not in `related`).
const taskProps: P[] = [
  prop("hours", "Hours", "number"),
  prop("done", "Done", "checkbox"),
  prop("due", "Due", "date"),
  prop("tags", "Tags", "multi_select", {
    options: [
      { id: "a", name: "alpha", color: "gray" },
      { id: "b", name: "beta", color: "red" },
    ],
  }),
  prop("owner", "Owner", "person"),
  prop("double", "Double", "formula", { formula: { expression: 'prop("hours") * 2', type: "number" } }),
];
const related = new Map<string, RelatedRow>([
  ["t1", { title: "Design", properties: { hours: 3, done: true, due: "2026-09-01", tags: ["a", "b"], owner: ["u1"], double: 6 } }],
  ["t2", { title: "Build", properties: { hours: 5, done: false, due: "2026-09-20", tags: ["a"], double: 10 } }],
  ["t3", { title: "Ship", properties: { done: true, due: "2026-09-10", double: { error: { code: "divisionByZero", message: "x", params: {} } } } }],
]);
const projectProps: P[] = [prop("rel", "Tasks", "relation", { relation: { databaseId: "tasks" } })];
const links = ["t1", "t2", "t3", "t4", "t1"];
const ctx = { now: NOW, people: [{ id: "u1", name: "Ada" }] };

function run(config: Partial<RollupConfig>, value: unknown = links) {
  const self = rollup("r", config);
  const resolved = resolveRollup(self, [...projectProps, self], taskProps);
  if (isErrorValue(resolved)) return resolved;
  return rollupValue(resolved as ResolvedRollup, value, related, ctx);
}

describe("rollups", () => {
  it("count the linked rows the viewer can see, each once", () => {
    expect(run({ function: "count_all" })).toBe(3);
    expect(run({ function: "count_all" }, [])).toBe(0);
    expect(run({ function: "count_all" }, null)).toBe(0);
    expect(run({ function: "count_all" }, ["t4"])).toBe(0);
  });

  it("count values, and calculate numbers", () => {
    expect(run({ function: "count_values", targetPropertyId: "tags" })).toBe(3);
    expect(run({ function: "count_unique", targetPropertyId: "tags" })).toBe(2);
    expect(run({ function: "sum", targetPropertyId: "hours" })).toBe(8);
    expect(run({ function: "average", targetPropertyId: "hours" })).toBe(4);
    expect(run({ function: "min", targetPropertyId: "hours" })).toBe(3);
    expect(run({ function: "max", targetPropertyId: "hours" })).toBe(5);
    expect(run({ function: "average", targetPropertyId: "hours" }, ["t3"])).toBeNull();
  });

  it("calculate percentages, dates and checkboxes", () => {
    expect(run({ function: "percent_checked", targetPropertyId: "done" })).toBeCloseTo(2 / 3);
    expect(run({ function: "count_unchecked", targetPropertyId: "done" })).toBe(1);
    expect(run({ function: "earliest_date", targetPropertyId: "due" })).toBe("2026-09-01");
    expect(run({ function: "latest_date", targetPropertyId: "due" })).toBe("2026-09-20");
    expect(run({ function: "date_range", targetPropertyId: "due" })).toBe(19);
  });

  it("show the original values by name", () => {
    expect(run({ function: "show_original" })).toEqual(["Design", "Build", "Ship"]);
    expect(run({ function: "show_original", targetPropertyId: "tags" })).toEqual(["alpha", "beta", "alpha"]);
    expect(run({ function: "show_original", targetPropertyId: "owner" })).toEqual(["Ada"]);
    expect(run({ function: "show_original", targetPropertyId: "hours" })).toEqual(["3", "5"]);
    expect(run({ function: "show_original", targetPropertyId: "due" })).toEqual(["2026-09-01", "2026-09-20", "2026-09-10"]);
  });

  it("calculate over formulas by their result type, errors counting as empty", () => {
    expect(run({ function: "sum", targetPropertyId: "double" })).toBe(16);
    expect(run({ function: "count_empty", targetPropertyId: "double" })).toBe(1);
  });

  it("report a deleted relation, a deleted target and a function that doesn't fit", () => {
    const self = rollup("r", { targetPropertyId: "hours", function: "sum" });
    expect(resolveRollup(self, [self], taskProps)).toMatchObject({ error: { code: "rollupRelation" } });
    expect(resolveRollup(self, [...projectProps, self], taskProps.slice(1))).toMatchObject({ error: { code: "rollupTarget" } });
    const wrong = rollup("r", { targetPropertyId: "tags", function: "sum" });
    expect(resolveRollup(wrong, [...projectProps, wrong], taskProps)).toMatchObject({
      error: { code: "rollupFunction", params: { property: "Tags" } },
    });
  });

  it("roll up nothing from a related database the viewer can't see", () => {
    const self = rollup("r", { targetPropertyId: "hours", function: "count_all" });
    const resolved = resolveRollup(self, [...projectProps, self], undefined) as ResolvedRollup;
    expect(rollupValue(resolved, links, new Map(), ctx)).toBe(0);
  });

  it("offer showing the original values first, then the target's calculations", () => {
    expect(rollupFunctions("number").slice(0, 2)).toEqual(["show_original", "count_all"]);
    expect(rollupFunctions("checkbox")).toContain("percent_checked");
    expect(rollupFunctions("title")).not.toContain("sum");
  });

  it("have a result type that decides how they filter and sort", () => {
    expect(valueType(rollup("r", { function: "sum" }))).toBe("number");
    expect(valueType(rollup("r", { function: "latest_date" }))).toBe("date");
    expect(derivedType(rollup("r", { function: "show_original" }))).toBe("text");
    const props = [
      rollup("pct", { function: "percent_checked", targetPropertyId: "done" }),
      rollup("names", { function: "show_original" }),
    ];
    const rows = [
      { id: "1", title: "a", properties: { pct: 0.75, names: ["Design", "Build"] }, createdAt: NOW, updatedAt: NOW },
      { id: "2", title: "b", properties: { pct: 0.25, names: ["Ship"] }, createdAt: NOW, updatedAt: NOW },
    ];
    // Percentages filter by the percent shown.
    expect(applyView(rows, { filters: [{ propertyId: "pct", op: "gt", value: 50 }] }, props).map((r) => r.title)).toEqual(["a"]);
    expect(applyView(rows, { filters: [{ propertyId: "names", op: "contains", value: "ship" }] }, props).map((r) => r.title)).toEqual(["b"]);
    expect(applyView(rows, { sorts: [{ propertyId: "pct", direction: "asc" }] }, props).map((r) => r.title)).toEqual(["b", "a"]);
  });

  it("filter an average of a percent property by the percent shown, and of plain numbers as they are", () => {
    const percent = { format: "percent" as const };
    const props = [
      rollup("avg", { function: "average", targetPropertyId: "share", number: percent }),
      rollup("plain", { function: "average", targetPropertyId: "hours" }),
    ];
    const rows = [
      { id: "1", title: "a", properties: { avg: 0.3, plain: 0.3 }, createdAt: NOW, updatedAt: NOW },
      { id: "2", title: "b", properties: { avg: 0.1, plain: 30 }, createdAt: NOW, updatedAt: NOW },
    ];
    expect(applyView(rows, { filters: [{ propertyId: "avg", op: "gt", value: 20 }] }, props).map((r) => r.title)).toEqual(["a"]);
    expect(applyView(rows, { filters: [{ propertyId: "plain", op: "gt", value: 20 }] }, props).map((r) => r.title)).toEqual(["b"]);
  });

  it("feed formulas, which see errors as errors", () => {
    const props = [
      rollup("total", { function: "sum", targetPropertyId: "hours" }),
      rollup("names", { function: "show_original" }),
      prop("f", "F", "formula", { formula: { expression: 'prop("total") * 2' } }),
      prop("g", "G", "formula", { formula: { expression: 'join(prop("names"), "+")' } }),
    ];
    const [ok] = withFormulas(props, [{ title: "p", properties: { total: 8, names: ["a", "b"] } }], { now: NOW });
    expect(ok.properties).toMatchObject({ f: 16, g: "a+b" });
    const broken = { error: { code: "rollupTarget" as const, message: "gone", params: {} } };
    const [bad] = withFormulas(props, [{ title: "p", properties: { total: broken, names: [] } as Record<string, unknown> }], { now: NOW });
    expect(bad.properties.f).toMatchObject({ error: { code: "referenceError", params: { name: "total" } } });
  });
});

describe("duplicating rollups and formulas", () => {
  const base = {
    rootId: "root",
    rootTitle: "Copy",
    rootPosition: 1,
    views: [],
  };
  const pages = [
    { id: "root", parentId: null, kind: "page" as const, title: "root", position: 1, properties: {} },
    { id: "projects", parentId: "root", kind: "database" as const, title: "p", position: 1, properties: {} },
    { id: "tasks", parentId: "root", kind: "database" as const, title: "t", position: 2, properties: {} },
  ];
  const properties = [
    { id: "hours", databaseId: "tasks", name: "Hours", type: "number" as const, options: {}, position: 1 },
    { id: "rel", databaseId: "projects", name: "Tasks", type: "relation" as const, options: { relation: { databaseId: "tasks" } }, position: 1 },
    { id: "out", databaseId: "projects", name: "Out", type: "relation" as const, options: { relation: { databaseId: "elsewhere" } }, position: 2 },
    {
      id: "sum",
      databaseId: "projects",
      name: "Sum",
      type: "rollup" as const,
      options: { rollup: { relationPropertyId: "rel", targetPropertyId: "hours", function: "sum" as const } },
      position: 3,
    },
    {
      id: "far",
      databaseId: "projects",
      name: "Far",
      type: "rollup" as const,
      options: { rollup: { relationPropertyId: "out", targetPropertyId: "x1", function: "count_all" as const } },
      position: 4,
    },
    {
      id: "f",
      databaseId: "projects",
      name: "F",
      type: "formula" as const,
      options: { formula: { expression: 'prop("sum") + prop("title")' } },
      position: 5,
    },
  ];
  let n = 0;
  const plan = planDuplicate({ ...base, pages, properties }, () => `new${++n}`);
  const byName = (name: string) => plan.properties.find((p) => p.name === name)!;

  it("point rollups at the copied relation, and at copied targets inside the copy", () => {
    expect(byName("Sum").options.rollup).toMatchObject({ relationPropertyId: byName("Tasks").id, targetPropertyId: byName("Hours").id });
    // The related database wasn't copied: the target stays the original's property.
    expect(byName("Far").options.rollup).toMatchObject({ relationPropertyId: byName("Out").id, targetPropertyId: "x1" });
  });

  it("point formulas at the copied properties", () => {
    expect(byName("F").options.formula?.expression).toBe(`prop("${byName("Sum").id}") + prop("title")`);
  });
});

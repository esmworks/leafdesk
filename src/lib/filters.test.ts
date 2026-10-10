import { describe, expect, it } from "vitest";
import type { FilterEntry, FilterRule, PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  filterConfigError,
  filterRules,
  mapFilterRules,
  pruneFilters,
  relativeDateRange,
  requiredFilterRules,
  valueDay,
} from "./filters";
import { applyView, defaultsFromFilters, filterOperators, isIncompleteFilter, type RowLike } from "./properties";

const prop = (type: PropertyType, options: PropertyOptions = {}) => ({ id: `p_${type}`, name: type, type, options });

const status = prop("select", {
  options: [
    { id: "o1", name: "Not started", color: "gray" },
    { id: "o2", name: "In progress", color: "blue" },
    { id: "o3", name: "Done", color: "green" },
  ],
});
const tags = prop("multi_select", {
  options: [
    { id: "t1", name: "Bug", color: "red" },
    { id: "t2", name: "UI", color: "purple" },
  ],
});
const owner = prop("person");
const due = prop("date");
const props = [status, tags, owner, due, prop("number"), prop("checkbox")];

// Local times, so the checks hold in every time zone: relative dates count local days.
const WEDNESDAY = new Date(2026, 8, 30, 12); // 2026-09-30

const row = (id: string, properties: Record<string, unknown> = {}, created = WEDNESDAY): RowLike => ({
  id,
  title: id,
  properties,
  createdAt: created,
  updatedAt: created,
});

const rows = [
  row("a", { p_select: "o3", p_multi_select: ["t1"], p_person: ["u1"], p_number: 1 }),
  row("b", { p_select: "o1", p_multi_select: ["t2"], p_person: ["u2"], p_number: 5 }),
  row("c", { p_select: "o2", p_multi_select: ["t1", "t2"], p_person: ["u1", "u2"], p_number: 10 }),
  row("d"),
];

const rule = (propertyId: string, op: FilterRule["op"], value?: unknown): FilterRule =>
  value === undefined ? { propertyId, op } : { propertyId, op, value };
const or = (...rules: FilterEntry[]): FilterEntry => ({ type: "group", combinator: "or", rules });
const and = (...rules: FilterEntry[]): FilterEntry => ({ type: "group", combinator: "and", rules });

const ids = (filters: FilterEntry[], filterCombinator?: "and" | "or", viewerId?: string) =>
  applyView(rows, { filters, filterCombinator }, props, { viewerId, now: WEDNESDAY }).map((r) => r.id);

describe("filter groups", () => {
  it("combines top-level rules with and by default, or when asked", () => {
    const done = rule("p_select", "equals", "o3");
    const ui = rule("p_multi_select", "contains", "t2");
    expect(ids([done, ui])).toEqual([]);
    expect(ids([done, ui], "and")).toEqual([]);
    expect(ids([done, ui], "or")).toEqual(["a", "b", "c"]);
  });

  it("evaluates groups with their own combinator", () => {
    // Bug and (Done or number > 5)
    const filters = [rule("p_multi_select", "contains", "t1"), or(rule("p_select", "equals", "o3"), rule("p_number", "gt", 5))];
    expect(ids(filters)).toEqual(["a", "c"]);
    // Not started or (UI and number > 5)
    const other = [rule("p_select", "equals", "o1"), and(rule("p_multi_select", "contains", "t2"), rule("p_number", "gt", 5))];
    expect(ids(other, "or")).toEqual(["b", "c"]);
  });

  it("evaluates groups nested in groups", () => {
    // number < 5 or (UI and (Not started or In progress))
    const filters = [
      rule("p_number", "lt", 5),
      and(rule("p_multi_select", "contains", "t2"), or(rule("p_select", "equals", "o1"), rule("p_select", "equals", "o2"))),
    ];
    expect(ids(filters, "or")).toEqual(["a", "b", "c"]);
    expect(ids(filters, "and")).toEqual([]);
  });

  it("ignores incomplete rules and empty groups, also inside an or", () => {
    const done = rule("p_select", "equals", "o3");
    const incomplete = rule("p_select", "equals");
    // An incomplete branch of an "or" must not make the "or" match every row.
    expect(ids([done, incomplete], "or")).toEqual(["a"]);
    expect(ids([done, or(incomplete)], "or")).toEqual(["a"]);
    expect(ids([done, { type: "group", combinator: "or", rules: [] }], "or")).toEqual(["a"]);
    expect(ids([or(incomplete, rule("p_multi_select", "contains"))])).toEqual(["a", "b", "c", "d"]);
    expect(ids([{ type: "group", combinator: "and", rules: [] }])).toEqual(["a", "b", "c", "d"]);
  });

  it("resolves person filters on me inside groups", () => {
    const filters = [or(rule("p_person", "contains", "me"), rule("p_select", "equals", "o2"))];
    expect(ids(filters, "and", "u1")).toEqual(["a", "c"]);
    expect(ids(filters, "and", "u2")).toEqual(["b", "c"]);
    // A published page has no viewer: "me" is nobody.
    expect(ids(filters)).toEqual(["c"]);
  });

  it("keeps stored rule lists from before groups working unchanged", () => {
    const legacy: FilterRule[] = [rule("p_multi_select", "contains", "t1"), rule("p_number", "gt", 5)];
    expect(applyView(rows, { filters: legacy }, props).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("relative date filters", () => {
  const within = (value: unknown, days?: number): FilterRule => ({ propertyId: "p_date", op: "is_within", value, days });
  const dated = (...days: string[]) => days.map((day) => row(day, { p_date: day }));
  const matching = (filter: FilterRule, list: RowLike[], now = WEDNESDAY) =>
    applyView(list, { filters: [filter] }, props, { now }).map((r) => r.id);

  it("computes ranges from the local day of now, weeks starting on Monday", () => {
    expect(relativeDateRange("today", undefined, WEDNESDAY)).toEqual({ start: "2026-09-30", end: "2026-09-30" });
    expect(relativeDateRange("this_week", undefined, WEDNESDAY)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(relativeDateRange("this_month", undefined, WEDNESDAY)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(relativeDateRange("past_n_days", 7, WEDNESDAY)).toEqual({ start: "2026-09-23", end: "2026-09-30" });
    expect(relativeDateRange("next_n_days", 7, WEDNESDAY)).toEqual({ start: "2026-09-30", end: "2026-10-07" });
  });

  it("handles week, month and year edges", () => {
    const sunday = new Date(2026, 9, 4, 23, 59);
    const monday = new Date(2026, 8, 28, 0, 1);
    expect(relativeDateRange("this_week", undefined, sunday)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(relativeDateRange("this_week", undefined, monday)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    const newYearsEve = new Date(2026, 11, 31, 18);
    expect(relativeDateRange("next_n_days", 3, newYearsEve)).toEqual({ start: "2026-12-31", end: "2027-01-03" });
    expect(relativeDateRange("this_week", undefined, newYearsEve)).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(relativeDateRange("this_month", undefined, new Date(2028, 1, 10))).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("rejects unknown ranges and bad day counts", () => {
    expect(relativeDateRange("yesterday", undefined, WEDNESDAY)).toBeNull();
    expect(relativeDateRange("past_n_days", undefined, WEDNESDAY)).toBeNull();
    expect(relativeDateRange("past_n_days", 0, WEDNESDAY)).toBeNull();
    expect(relativeDateRange("next_n_days", 2.5, WEDNESDAY)).toBeNull();
  });

  it("filters date properties by relative ranges", () => {
    const list = dated("2026-09-22", "2026-09-23", "2026-09-28", "2026-09-30", "2026-10-01", "2026-10-05", "2026-10-07", "2026-10-08");
    expect(matching(within("today"), list)).toEqual(["2026-09-30"]);
    expect(matching(within("this_week"), list)).toEqual(["2026-09-28", "2026-09-30", "2026-10-01"]);
    expect(matching(within("this_month"), list)).toEqual(["2026-09-22", "2026-09-23", "2026-09-28", "2026-09-30"]);
    expect(matching(within("past_n_days", 7), list)).toEqual(["2026-09-23", "2026-09-28", "2026-09-30"]);
    expect(matching(within("next_n_days", 7), list)).toEqual(["2026-09-30", "2026-10-01", "2026-10-05", "2026-10-07"]);
    // Rows without a date never match.
    expect(matching(within("today"), [row("empty")])).toEqual([]);
  });

  it("matches ranges that overlap the day or period", () => {
    const list = [
      row("past", { p_date: "2026-09-20/2026-09-27" }),
      row("into", { p_date: "2026-09-25/2026-09-29" }),
      row("across", { p_date: "2026-09-27/2026-10-08" }),
      row("later", { p_date: "2026-10-05/2026-10-06" }),
    ];
    expect(matching(within("this_week"), list)).toEqual(["into", "across"]);
    expect(matching(within("today"), list)).toEqual(["across"]);
    const rule = (op: "equals" | "lt" | "gt", value: string): FilterRule => ({ propertyId: "p_date", op, value });
    expect(matching(rule("equals", "2026-09-29"), list)).toEqual(["into", "across"]);
    // Before: starts before the day; after: ends after it.
    expect(matching(rule("lt", "2026-09-25"), list)).toEqual(["past"]);
    expect(matching(rule("gt", "2026-09-29"), list)).toEqual(["across", "later"]);
  });

  it("places times on the local day", () => {
    const at = new Date(2026, 8, 30, 23, 30).toISOString();
    const list = [row("late", { p_date: at }), row("span", { p_date: `${at}/${new Date(2026, 9, 1, 1).toISOString()}` })];
    expect(matching(within("today"), list)).toEqual(["late", "span"]);
    expect(matching({ propertyId: "p_date", op: "equals", value: "2026-10-01" }, list)).toEqual(["span"]);
  });

  it("follows now instead of the date the view was saved", () => {
    const list = dated("2026-09-30", "2026-10-01");
    expect(matching(within("today"), list, new Date(2026, 9, 1, 9))).toEqual(["2026-10-01"]);
  });

  it("counts timestamps (created / edited time) on their local day", () => {
    const lateTuesday = new Date(2026, 8, 29, 23, 30);
    const list = [row("tue", {}, lateTuesday), row("wed", {}, WEDNESDAY)];
    const today: FilterRule = { propertyId: "created_at", op: "is_within", value: "today" };
    expect(applyView(list, { filters: [today] }, props, { now: WEDNESDAY }).map((r) => r.id)).toEqual(["wed"]);
    expect(valueDay(lateTuesday.toISOString())).toBe("2026-09-29");
    expect(valueDay("2026-09-29")).toBe("2026-09-29");
    expect(valueDay("not a date")).toBeNull();
  });

  it("treats a rule without a range or day count as incomplete", () => {
    expect(isIncompleteFilter(within(undefined))).toBe(true);
    expect(isIncompleteFilter(within("past_n_days"))).toBe(true);
    expect(isIncompleteFilter(within("past_n_days", 3))).toBe(false);
    expect(isIncompleteFilter(within("this_week"))).toBe(false);
    const list = dated("2026-01-01");
    expect(matching(within("past_n_days"), list)).toEqual(["2026-01-01"]);
  });

  it("is offered for dates", () => {
    expect(filterOperators("date").map((o) => o.op)).toContain("is_within");
    expect(filterOperators("text").map((o) => o.op)).not.toContain("is_within");
  });
});

describe("defaults from filters with groups", () => {
  it("uses rules joined by and, including those in and-groups", () => {
    const filters = [rule("p_select", "equals", "o2"), and(rule("p_multi_select", "contains", "t1"), rule("p_checkbox", "is_not_empty"))];
    expect(defaultsFromFilters(filters, props)).toEqual({ p_select: "o2", p_multi_select: ["t1"], p_checkbox: true });
  });

  it("skips rules inside an or", () => {
    const filters = [rule("p_select", "equals", "o2"), or(rule("p_multi_select", "contains", "t1"), rule("p_person", "contains", "me"))];
    expect(defaultsFromFilters(filters, props, { viewerId: "u1" })).toEqual({ p_select: "o2" });
    expect(defaultsFromFilters(filters, props, { viewerId: "u1" }, "or")).toEqual({});
    // An and-group inside an or is still only one alternative.
    const nested = [or(and(rule("p_select", "equals", "o3")), rule("p_select", "equals", "o1"))];
    expect(defaultsFromFilters(nested, props)).toEqual({});
  });

  it("treats an or with a single active rule as that rule", () => {
    const filters = [rule("p_select", "equals", "o2"), rule("p_multi_select", "contains")];
    expect(defaultsFromFilters(filters, props, {}, "or")).toEqual({ p_select: "o2" });
    expect(defaultsFromFilters([or(rule("p_person", "contains", "me"))], props, { viewerId: "u1" })).toEqual({ p_person: ["u1"] });
  });

  it("dates new rows today for relative date rules", () => {
    const filters: FilterRule[] = [{ propertyId: "p_date", op: "is_within", value: "next_n_days", days: 7 }];
    expect(defaultsFromFilters(filters, props, { now: WEDNESDAY })).toEqual({ p_date: "2026-09-30" });
    expect(defaultsFromFilters([{ propertyId: "p_date", op: "is_within" }], props, { now: WEDNESDAY })).toEqual({});
  });
});

describe("filter tree helpers", () => {
  const tree: FilterEntry[] = [
    rule("p_select", "equals", "o1"),
    or(rule("p_person", "contains", "u1"), and(rule("p_person", "contains", "u2"), rule("p_number", "gt", 1))),
    or(rule("p_person", "is_empty")),
  ];

  it("lists every rule", () => {
    expect(filterRules(tree).map((r) => r.propertyId)).toEqual(["p_select", "p_person", "p_person", "p_number", "p_person"]);
    expect(filterRules(undefined)).toEqual([]);
  });

  it("maps and drops rules, dropping groups left empty", () => {
    const withoutPerson = mapFilterRules(tree, (r) => (r.propertyId === "p_person" ? null : r));
    expect(withoutPerson).toEqual([rule("p_select", "equals", "o1"), or(and(rule("p_number", "gt", 1)))]);
    const renamed = mapFilterRules(tree, (r) => ({ ...r, propertyId: r.propertyId.toUpperCase() }));
    expect(filterRules(renamed).map((r) => r.propertyId)).toEqual(["P_SELECT", "P_PERSON", "P_PERSON", "P_NUMBER", "P_PERSON"]);
  });

  it("prunes inactive rules and finds the required ones", () => {
    const pruned = pruneFilters(tree, (r) => r.op !== "is_empty");
    expect(pruned).toHaveLength(2);
    expect(requiredFilterRules(pruned, "and").map((r) => r.propertyId)).toEqual(["p_select"]);
    expect(requiredFilterRules(pruned, "or")).toEqual([]);
  });
});

describe("filterConfigError", () => {
  it("accepts old rule lists, groups two levels deep and incomplete rules", () => {
    expect(filterConfigError({})).toBeNull();
    expect(filterConfigError({ filters: [rule("p_select", "equals", "o1")] })).toBeNull();
    expect(filterConfigError({ filters: [or(and(rule("p_select", "equals")))], filterCombinator: "or" })).toBeNull();
    expect(filterConfigError({ filters: [{ propertyId: "p_date", op: "is_within" }] })).toBeNull();
  });

  it("rejects unknown ops, bad groups and too deep nesting", () => {
    expect(filterConfigError({ filters: [{ propertyId: "p_select", op: "matches" as never }] })).toMatch(/Unknown filter operator "matches"/);
    expect(filterConfigError({ filters: [or(and(or(rule("p_select", "equals", "o1"))))] })).toMatch(/at most 2 levels/);
    expect(filterConfigError({ filters: [{ type: "group", combinator: "xor", rules: [] } as never] })).toMatch(/"and" or "or"/);
    expect(filterConfigError({ filterCombinator: "xor" as never })).toMatch(/"and" or "or"/);
    expect(filterConfigError({ filters: "all" as never })).toMatch(/list/);
    expect(filterConfigError({ filters: [{ op: "equals" } as never] })).toMatch(/needs a property/);
    expect(filterConfigError({ filters: [{ propertyId: "p_date", op: "is_within", value: "someday" }] })).toMatch(/today, this_week/);
    expect(filterConfigError({ filters: [{ propertyId: "p_date", op: "is_within", value: "past_n_days", days: 0 }] })).toMatch(/Days/);
    const many = Array.from({ length: 101 }, () => rule("p_select", "is_empty"));
    expect(filterConfigError({ filters: many })).toMatch(/at most 100/);
  });
});

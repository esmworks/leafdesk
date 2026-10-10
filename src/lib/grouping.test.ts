import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  arrangeGroups,
  boardGroupProperty,
  dateBucket,
  groupDefaults,
  groupRowsBy,
  groupTarget,
  isGroupable,
  moveGroupValue,
  type Group,
} from "./grouping";
import { makeStatusOptions } from "./properties";

const prop = (type: PropertyType, options: PropertyOptions = {}) => ({ id: `p_${type}`, name: type, type, options });
const row = (id: string, properties: Record<string, unknown> = {}) => ({ id, properties });
type R = ReturnType<typeof row>;

const keys = (groups: Group<R>[]) => groups.map((g) => g.key);
const members = (groups: Group<R>[]) => groups.map((g) => g.rows.map((r) => r.id));

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
    { id: "t3", name: "Docs", color: "blue" },
  ],
});
let n = 0;
const stage = prop("status", {
  options: makeStatusOptions(["Idea", "Doing", "Review", "Shipped"], () => `s${++n}`),
});

/** The calendar day of a timestamp in a given time zone, like a viewer there sees it. */
const dayIn = (timeZone: string) => (value: unknown) =>
  typeof value === "string" ? new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value)) : null;

describe("groupRowsBy", () => {
  it("groups selects by option order with no value first", () => {
    const rows = [row("a", { p_select: "o2" }), row("b"), row("c", { p_select: "o1" }), row("d", { p_select: "gone" })];
    const groups = groupRowsBy(rows, select);
    expect(keys(groups)).toEqual(["", "o1", "o2"]);
    expect(members(groups)).toEqual([["b", "d"], ["c"], ["a"]]);
    expect(groups[1].value).toEqual({ kind: "option", option: select.options.options![0] });
    expect(groups[0].value).toEqual({ kind: "none" });
  });

  it("groups statuses by option, or by stage when asked", () => {
    const rows = [row("a", { p_status: "s1" }), row("b", { p_status: "s3" }), row("c", { p_status: "s2" }), row("d")];
    expect(keys(groupRowsBy(rows, stage))).toEqual(["", "s1", "s2", "s3", "s4"]);
    const byStage = groupRowsBy(rows, stage, { groupStatusBy: "group" });
    expect(keys(byStage)).toEqual(["", "todo", "in_progress", "done"]);
    expect(members(byStage)).toEqual([["d"], ["a"], ["b", "c"], []]);
    expect(byStage[2].value).toEqual({ kind: "status_group", group: "in_progress" });
  });

  it("puts a multi-select row in each of its options' groups", () => {
    const rows = [row("a", { p_multi_select: ["t2", "t1", "t2"] }), row("b", { p_multi_select: ["gone"] }), row("c", { p_multi_select: ["t2"] })];
    const groups = groupRowsBy(rows, tags);
    expect(keys(groups)).toEqual(["", "t1", "t2", "t3"]);
    expect(members(groups)).toEqual([["b"], ["a"], ["a", "c"], []]);
  });

  it("groups by person like boards always did, created by included", () => {
    const people = [
      { id: "u1", name: "Ada", active: true },
      { id: "u2", name: "Bo", active: true },
      { id: "u3", name: "Cy", active: false },
    ];
    const rows = [row("a", { p_person: ["u2", "u1"] }), row("b"), row("c", { p_person: ["u3"] })];
    const groups = groupRowsBy(rows, prop("person"), {}, { people });
    expect(keys(groups)).toEqual(["", "u1", "u2", "u3"]);
    expect(members(groups)).toEqual([["b"], ["a"], ["a"], ["c"]]);
    expect(groups[3].value).toEqual({ kind: "person", person: people[2] });
    const creators = groupRowsBy([row("x", { p_created_by: ["u1"] })], prop("created_by"), {}, { people });
    expect(keys(creators)).toEqual(["", "u1", "u2"]);
  });

  it("groups checkboxes into unchecked and checked, with no separate empty group", () => {
    const rows = [row("a", { p_checkbox: true }), row("b", { p_checkbox: false }), row("c"), row("d", { p_checkbox: "true" })];
    const groups = groupRowsBy(rows, prop("checkbox"));
    expect(keys(groups)).toEqual(["false", "true"]);
    expect(members(groups)).toEqual([["b", "c", "d"], ["a"]]);
    expect(groups.map((g) => g.value)).toEqual([
      { kind: "checkbox", checked: false },
      { kind: "checkbox", checked: true },
    ]);
  });

  it("buckets dates by day, week, month and year, oldest first", () => {
    const rows = [
      row("a", { p_date: "2026-09-27" }), // Sunday
      row("b", { p_date: "2026-09-21" }), // Monday of the same week
      row("c", { p_date: "2026-09-28" }), // Monday of the next week
      row("d", { p_date: "2025-12-31" }),
      row("e"),
      row("f", { p_date: "not a date" }),
    ];
    const date = prop("date");
    const by = (groupDateBy: "day" | "week" | "month" | "year") => groupRowsBy(rows, date, { groupDateBy });
    expect(keys(by("day"))).toEqual(["", "2025-12-31", "2026-09-21", "2026-09-27", "2026-09-28"]);
    expect(keys(by("week"))).toEqual(["", "2025-12-29", "2026-09-21", "2026-09-28"]);
    expect(members(by("week"))).toEqual([["e", "f"], ["d"], ["a", "b"], ["c"]]);
    expect(keys(by("month"))).toEqual(["", "2025-12-01", "2026-09-01"]);
    expect(keys(by("year"))).toEqual(["", "2025-01-01", "2026-01-01"]);
    expect(by("week")[2].value).toEqual({ kind: "date", by: "week", start: "2026-09-21", end: "2026-09-27" });
    // Month is the default, and unknown settings fall back to it.
    expect(keys(groupRowsBy(rows, date))).toEqual(keys(by("month")));
    expect(keys(groupRowsBy(rows, date, { groupDateBy: "decade" as never }))).toEqual(keys(by("month")));
  });

  it("computes bucket bounds across month, year and leap-day edges", () => {
    expect(dateBucket("2024-02-10", "month")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(dateBucket("2026-01-01", "week")).toEqual({ start: "2025-12-29", end: "2026-01-04" });
    expect(dateBucket("2026-03-29", "week")).toEqual({ start: "2026-03-23", end: "2026-03-29" });
    expect(dateBucket("2026-09-27", "year")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(dateBucket("2026-09-27", "day")).toEqual({ start: "2026-09-27", end: "2026-09-27" });
  });

  it("buckets created and last edited times by the viewer's day", () => {
    // 21:30 UTC on Sunday is already Monday in Istanbul, but still Sunday in New York.
    const rows = [row("a", { p_created_time: "2026-09-27T21:30:00.000Z" }), row("b", { p_created_time: null })];
    const created = prop("created_time");
    const istanbul = groupRowsBy(rows, created, { groupDateBy: "week" }, { dayOf: dayIn("Europe/Istanbul") });
    const newYork = groupRowsBy(rows, created, { groupDateBy: "week" }, { dayOf: dayIn("America/New_York") });
    expect(keys(istanbul)).toEqual(["", "2026-09-28"]);
    expect(keys(newYork)).toEqual(["", "2026-09-21"]);
    expect(members(istanbul)).toEqual([["b"], ["a"]]);
    const edited = [row("c", { p_last_edited_time: "2026-09-27T21:30:00.000Z" })];
    expect(keys(groupRowsBy(edited, prop("last_edited_time"), { groupDateBy: "day" }, { dayOf: dayIn("UTC") }))).toEqual([
      "",
      "2026-09-27",
    ]);
  });

  it("groups relations by linked row, in the related database's order, a row under each link", () => {
    const relationRows = [
      { id: "r1", title: "Alpha", icon: null },
      { id: "r2", title: "Beta", icon: "🅱️" },
      { id: "r3", title: "Gamma", icon: null },
    ];
    const rows = [
      row("a", { p_relation: ["r3", "r1"] }),
      row("b", { p_relation: ["hidden"] }),
      row("c", { p_relation: ["r3"] }),
      row("d"),
    ];
    const groups = groupRowsBy(rows, prop("relation"), {}, { relationRows });
    // Related rows nobody links to get no group.
    expect(keys(groups)).toEqual(["", "r1", "r3"]);
    expect(members(groups)).toEqual([["b", "d"], ["a"], ["a", "c"]]);
    expect(groups[2].value).toEqual({ kind: "relation", row: relationRows[2] });
  });

  it("keeps keys stable when values change and rows come and go", () => {
    const before = groupRowsBy([row("a", { p_select: "o1" })], select);
    const after = groupRowsBy([row("b", { p_select: "o2" }), row("c")], select);
    expect(keys(before)).toEqual(keys(after));
    const date = prop("date");
    const one = groupRowsBy([row("a", { p_date: "2026-09-23" })], date, { groupDateBy: "week" });
    const two = groupRowsBy([row("b", { p_date: "2026-09-25" })], date, { groupDateBy: "week" });
    expect(keys(one)).toEqual(keys(two));
  });

  it("puts everything in no value for properties that can't group", () => {
    expect(members(groupRowsBy([row("a"), row("b")], prop("text")))).toEqual([["a", "b"]]);
  });
});

describe("groupable properties", () => {
  it("covers options, people, checkboxes, dates and relations, but not free text", () => {
    const groupable: PropertyType[] = [
      "select",
      "status",
      "multi_select",
      "person",
      "created_by",
      "last_edited_by",
      "checkbox",
      "date",
      "created_time",
      "last_edited_time",
      "relation",
    ];
    for (const type of groupable) expect(isGroupable(type), type).toBe(true);
    for (const type of ["text", "number", "url", "email", "phone", "checklist"] as const) expect(isGroupable(type), type).toBe(false);
  });

  it("boards fall back to a select or status, then people, then anything groupable", () => {
    expect(boardGroupProperty([prop("date"), prop("person")])?.type).toBe("person");
    expect(boardGroupProperty([prop("checkbox"), prop("date")])?.type).toBe("checkbox");
    expect(boardGroupProperty([prop("date"), select])?.type).toBe("select");
    expect(boardGroupProperty([prop("date"), select], "p_date")?.type).toBe("date");
  });
});

describe("arrangeGroups", () => {
  const rows = [row("a", { p_select: "o2" }), row("b", { p_select: "o2" })];

  it("orders, hides and drops the empty no-value group", () => {
    const groups = groupRowsBy(rows, select);
    const plain = arrangeGroups(groups, {});
    expect(keys(plain.shown)).toEqual(["o1", "o2"]);
    const arranged = arrangeGroups(groups, { groupOrder: ["o2"], hiddenGroups: ["o1"] });
    expect(keys(arranged.ordered)).toEqual(["o2", "", "o1"]);
    expect(keys(arranged.shown)).toEqual(["o2"]);
    expect(keys(arranged.hidden)).toEqual(["o1"]);
  });

  it("leaves out empty groups when asked", () => {
    const groups = groupRowsBy([...rows, row("c")], select);
    expect(keys(arrangeGroups(groups, { hideEmptyGroups: true }).shown)).toEqual(["", "o2"]);
    expect(keys(arrangeGroups(groups, { hideEmptyGroups: true, hiddenGroups: [""] }).hidden)).toEqual([""]);
  });
});

describe("moving rows between groups", () => {
  const groupsOf = (p: Parameters<typeof groupRowsBy>[1], rows: R[], settings = {}, context = {}) =>
    groupRowsBy(rows, p, settings, context);

  it("targets option, stage, checkbox, date and relation groups", () => {
    const [none, low] = groupsOf(select, []);
    expect(groupTarget(select, none)).toBeNull();
    expect(groupTarget(select, low)).toBe("o1");
    const stages = groupsOf(stage, [], { groupStatusBy: "group" });
    expect(stages.map((g) => groupTarget(stage, g))).toEqual([null, "s1", "s2", "s4"]);
    const noDone = prop("status", { options: makeStatusOptions([{ name: "Only", group: "todo" }], () => "x1") });
    expect(groupTarget(noDone, groupsOf(noDone, [], { groupStatusBy: "group" })[3])).toBeUndefined();
    const checkbox = prop("checkbox");
    expect(groupsOf(checkbox, []).map((g) => groupTarget(checkbox, g))).toEqual(["false", "true"]);
    const date = prop("date");
    const [, week] = groupsOf(date, [row("a", { p_date: "2026-09-24" })], { groupDateBy: "week" });
    expect(groupTarget(date, week)).toBe("2026-09-21");
    const relation = prop("relation");
    const [, linked] = groupsOf(relation, [row("a", { p_relation: ["r1"] })], {}, { relationRows: [{ id: "r1", title: "R", icon: null }] });
    expect(groupTarget(relation, linked)).toBe("r1");
  });

  it("never moves rows between groups of who created or edited them, or when", () => {
    const created = prop("created_time");
    const [, day] = groupsOf(created, [row("a", { p_created_time: "2026-09-27T10:00:00Z" })], {}, { dayOf: dayIn("UTC") });
    expect(groupTarget(created, day)).toBeUndefined();
    const people = [{ id: "u1", name: "Ada", active: true }];
    const creator = prop("created_by");
    expect(groupsOf(creator, [], {}, { people }).map((g) => groupTarget(creator, g))).toEqual([undefined, undefined]);
  });

  it("swaps list values like person boards and sets the rest outright", () => {
    expect(moveGroupValue(tags, ["t1", "t2"], "t1", "t3")).toEqual(["t3", "t2"]);
    expect(moveGroupValue(tags, ["t1", "gone"], "t1", "t2")).toEqual(["t2"]);
    expect(moveGroupValue(tags, ["t1", "t2"], "t1", "t2")).toEqual(["t2"]);
    expect(moveGroupValue(tags, ["t1", "t2"], "t1", null)).toEqual([]);
    expect(moveGroupValue(tags, null, null, "t1")).toEqual(["t1"]);
    expect(moveGroupValue(prop("relation"), ["r1", "r2"], "r2", "r3")).toEqual(["r1", "r3"]);
    expect(moveGroupValue(prop("person"), ["u1"], "u1", "u2")).toEqual(["u2"]);
    expect(moveGroupValue(prop("checkbox"), false, "false", "true")).toBe(true);
    expect(moveGroupValue(prop("checkbox"), true, "true", "false")).toBe(false);
    expect(moveGroupValue(prop("date"), "2026-01-05", "2025-12-29", "2026-09-21")).toBe("2026-09-21");
    // Ranges move whole, keeping their length; times keep their time of day.
    expect(moveGroupValue(prop("date"), "2026-01-05/2026-01-07", "2025-12-29", "2026-09-21")).toBe("2026-09-21/2026-09-23");
    expect(moveGroupValue(prop("date"), "2026-06-10T12:00:00.000Z", "2026-06-10", "2026-06-15")).toBe("2026-06-15T12:00:00.000Z");
    expect(moveGroupValue(select, "o1", "o1", null)).toBeNull();
  });

  it("gives new rows the value of the group they are added to", () => {
    const [none, low] = groupsOf(select, []);
    expect(groupDefaults(select, none)).toEqual({});
    expect(groupDefaults(select, low)).toEqual({ p_select: "o1" });
    const [, bug] = groupsOf(tags, []);
    expect(groupDefaults(tags, bug)).toEqual({ p_multi_select: ["t1"] });
    const checkbox = prop("checkbox");
    expect(groupsOf(checkbox, []).map((g) => groupDefaults(checkbox, g))).toEqual([{ p_checkbox: false }, { p_checkbox: true }]);
    const stages = groupsOf(stage, [], { groupStatusBy: "group" });
    expect(groupDefaults(stage, stages[3])).toEqual({ p_status: "s4" });
    const people = [{ id: "u1", name: "Ada", active: true }];
    const [, ada] = groupsOf(prop("person"), [], {}, { people });
    expect(groupDefaults(prop("person"), ada)).toEqual({ p_person: ["u1"] });
    const [, month] = groupsOf(prop("date"), [row("a", { p_date: "2026-09-24" })]);
    expect(groupDefaults(prop("date"), month)).toEqual({ p_date: "2026-09-01" });
  });
});

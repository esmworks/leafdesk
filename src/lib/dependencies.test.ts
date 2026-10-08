import { describe, expect, it } from "vitest";
import type { DependencyShift, RelationConfig } from "@/db/schema/app";
import {
  blockedByProperty,
  blockingProperty,
  dependencySettings,
  makesDependencyLoop,
  planShifts,
  rowSpan,
  skipWeekend,
  storedBlockers,
  type Span,
} from "./dependencies";
import { dayNumber, dayValue } from "./timeline";

const relation = (id: string, options: RelationConfig) => ({ id, databaseId: "db", type: "relation", options: { relation: options } });
const date = (id: string) => ({ id, databaseId: "db", type: "date", options: {} });

describe("dependency properties", () => {
  it("finds the blocked-by property and its other side only on a relation of the database with itself", () => {
    const by = relation("b", { databaseId: "db", pairedPropertyId: "k", role: "blocked_by" });
    const blocking = relation("k", { databaseId: "db", pairedPropertyId: "b" });
    const parent = relation("p", { databaseId: "db", pairedPropertyId: "s", role: "parent" });
    expect(blockedByProperty([parent, blocking, by])).toBe(by);
    expect(blockingProperty([parent, blocking, by])).toBe(blocking);
    expect(blockedByProperty([parent])).toBeNull();
    expect(blockedByProperty([relation("x", { databaseId: "other", role: "blocked_by" })])).toBeNull();
    expect(blockingProperty([relation("b", { databaseId: "db", role: "blocked_by" })])).toBeNull();
  });

  it("reads settings tolerantly", () => {
    const props = [date("s"), date("e"), { id: "t", databaseId: "db", type: "text", options: {} }];
    const by = (dependencies: RelationConfig["dependencies"]) => relation("b", { databaseId: "db", role: "blocked_by", dependencies });
    expect(dependencySettings(by(undefined), props)).toEqual({ shift: "overlap", skipWeekends: false, start: null, end: null });
    expect(
      dependencySettings(by({ shift: "keep_gap", skipWeekends: true, startPropertyId: "s", endPropertyId: "e" }), props),
    ).toEqual({ shift: "keep_gap", skipWeekends: true, start: "s", end: "e" });
    // A missing or retyped date property counts as unset; an end without a start is dropped.
    expect(dependencySettings(by({ startPropertyId: "t", endPropertyId: "e" }), props)).toMatchObject({ start: null, end: null });
    expect(dependencySettings(by({ startPropertyId: "s", endPropertyId: "gone" }), props)).toMatchObject({ start: "s", end: null });
    expect(dependencySettings(by({ startPropertyId: "s", endPropertyId: "s" }), props)).toMatchObject({ end: null });
    expect(dependencySettings(by({ shift: "sideways" as DependencyShift }), props).shift).toBe("overlap");
  });

  it("reads stored blockers without the row itself or repeats", () => {
    expect(storedBlockers({ id: "a", properties: { b: ["x", "a", "x", 3, "y"] } }, "b")).toEqual(["x", "y"]);
    expect(storedBlockers({ id: "a", properties: { b: "x" } }, "b")).toEqual([]);
  });

  it("finds loops through any number of rows", () => {
    const blockers = new Map([
      ["b", ["a"]],
      ["c", ["b"]],
    ]);
    expect(makesDependencyLoop(blockers, "a", "c")).toBe(true);
    expect(makesDependencyLoop(blockers, "a", "a")).toBe(true);
    expect(makesDependencyLoop(blockers, "c", "a")).toBe(false);
    expect(makesDependencyLoop(new Map([["x", ["y"]], ["y", ["x"]]]), "a", "x")).toBe(false);
  });

  it("reads spans", () => {
    expect(rowSpan("2026-10-05", "2026-10-07")).toEqual({ start: dayNumber("2026-10-05"), end: dayNumber("2026-10-07") });
    expect(rowSpan("2026-10-05", null)).toEqual({ start: dayNumber("2026-10-05"), end: dayNumber("2026-10-05") });
    expect(rowSpan("2026-10-05", "2026-10-01")).toEqual({ start: dayNumber("2026-10-05"), end: dayNumber("2026-10-05") });
    expect(rowSpan(null, "2026-10-01")).toBeNull();
  });

  it("skips weekends", () => {
    expect(dayValue(skipWeekend(dayNumber("2026-10-10")!))).toBe("2026-10-12"); // Saturday
    expect(dayValue(skipWeekend(dayNumber("2026-10-11")!))).toBe("2026-10-12"); // Sunday
    expect(dayValue(skipWeekend(dayNumber("2026-10-09")!))).toBe("2026-10-09"); // Friday
  });
});

describe("planShifts", () => {
  // Days of October 2026: 5 is a Monday.
  const d = (day: number) => dayNumber(`2026-10-${String(day).padStart(2, "0")}`)!;
  const span = (start: number, end = start): Span => ({ start: d(start), end: d(end) });
  type Row = { id: string; span: [number, number?] | null; by?: string[] };
  const plan = (
    rows: Row[],
    moved: Record<string, [number, number?] | null>,
    shift: DependencyShift,
    extra: { linked?: string[]; fixed?: string[]; skipWeekends?: boolean } = {},
  ) =>
    Object.fromEntries(
      planShifts({
        rows: rows.map((r) => ({ id: r.id, span: r.span && span(...r.span), blockedBy: r.by ?? [] })),
        moved: new Map(Object.entries(moved).map(([id, s]) => [id, s && span(...s)])),
        linked: new Set(extra.linked),
        fixed: new Set([...(extra.fixed ?? []), ...Object.keys(moved)]),
        shift,
        skipWeekends: extra.skipWeekends ?? false,
      }).map((s) => [s.id, `${dayValue(s.after.start).slice(8)}-${dayValue(s.after.end).slice(8)}`]),
    );

  it("overlap: moves a waiting row only when it would start on or before its blocker's end", () => {
    // A moved from 5-7 to 5-9; B (8-9) now overlaps and goes to 10-11.
    expect(plan([{ id: "a", span: [5, 9] }, { id: "b", span: [8, 9], by: ["a"] }], { a: [5, 7] }, "overlap")).toEqual({ b: "10-11" });
    // B starts after A ends: nothing moves; moving A earlier pulls nothing in.
    expect(plan([{ id: "a", span: [5, 8] }, { id: "b", span: [12, 13], by: ["a"] }], { a: [5, 7] }, "overlap")).toEqual({});
    expect(plan([{ id: "a", span: [1, 3] }, { id: "b", span: [12, 13], by: ["a"] }], { a: [5, 7] }, "overlap")).toEqual({});
  });

  it("keep_gap: moves a waiting row by as much as its blocker's end moved, either way", () => {
    expect(plan([{ id: "a", span: [5, 9] }, { id: "b", span: [12, 13], by: ["a"] }], { a: [5, 7] }, "keep_gap")).toEqual({ b: "14-15" });
    expect(plan([{ id: "a", span: [5, 6] }, { id: "b", span: [12, 13], by: ["a"] }], { a: [5, 7] }, "keep_gap")).toEqual({ b: "11-12" });
    // Moving the start alone keeps the end, so nothing follows.
    expect(plan([{ id: "a", span: [3, 7] }, { id: "b", span: [12, 13], by: ["a"] }], { a: [5, 7] }, "keep_gap")).toEqual({});
  });

  it("keep_gap: moving earlier stops after the latest blocker and never pulls in a late row", () => {
    const rows = (a: [number, number]): Row[] => [
      { id: "a", span: a },
      { id: "c", span: [5, 10] },
      { id: "b", span: [12, 13], by: ["a", "c"] },
    ];
    // A moved 4 days earlier; C still ends on the 10th, so B stops on the 11th.
    expect(plan(rows([5, 6]), { a: [5, 10] }, "keep_gap")).toEqual({ b: "11-12" });
    // B already started before C ended: it stays.
    expect(
      plan([{ id: "a", span: [5, 6] }, { id: "c", span: [5, 14] }, { id: "b", span: [12, 13], by: ["a", "c"] }], { a: [5, 10] }, "keep_gap"),
    ).toEqual({});
  });

  it("follows the chain, each row once, after all of its blockers", () => {
    // A pushes B and C; C also waits for B, so it lands after B's new end.
    const rows: Row[] = [
      { id: "a", span: [5, 9] },
      { id: "b", span: [8, 10], by: ["a"] },
      { id: "c", span: [9, 9], by: ["a", "b"] },
      { id: "d", span: [20, 21], by: ["c"] },
    ];
    expect(plan(rows, { a: [5, 7] }, "overlap")).toEqual({ b: "10-12", c: "13-13" });
    expect(plan(rows, { a: [5, 7] }, "keep_gap")).toEqual({ b: "10-12", c: "11-11", d: "22-23" });
  });

  it("moves a newly linked row out of the way by either rule", () => {
    const rows: Row[] = [{ id: "a", span: [5, 9] }, { id: "b", span: [6, 7], by: ["a"] }];
    expect(plan(rows, {}, "overlap", { linked: ["b"] })).toEqual({ b: "10-11" });
    expect(plan(rows, {}, "keep_gap", { linked: ["b"] })).toEqual({ b: "10-11" });
    expect(plan(rows, {}, "none", { linked: ["b"] })).toEqual({});
  });

  it("keeps rows the write dated, rows without dates, and rows waiting only for undated rows", () => {
    const rows: Row[] = [
      { id: "a", span: [5, 9] },
      { id: "b", span: [6, 7], by: ["a"] },
      { id: "u", span: null, by: ["a"] },
      { id: "c", span: [8, 8], by: ["u"] },
    ];
    expect(plan(rows, { a: [5, 7] }, "overlap", { fixed: ["b"] })).toEqual({});
    // A row with a start only is one day long; one with no blocker dates stays.
    expect(plan([{ id: "a", span: null }, { id: "b", span: [6], by: ["a"] }], { a: [5, 7] }, "overlap")).toEqual({});
  });

  it("goes to Monday when a moved row would start on a weekend", () => {
    // A now ends on Friday the 9th: B would start Saturday.
    const rows: Row[] = [{ id: "a", span: [5, 9] }, { id: "b", span: [8, 9], by: ["a"] }];
    expect(plan(rows, { a: [5, 7] }, "overlap", { skipWeekends: true })).toEqual({ b: "12-13" });
    expect(plan(rows, { a: [5, 7] }, "overlap")).toEqual({ b: "10-11" });
  });

  it("walks a loop once", () => {
    const rows: Row[] = [
      { id: "a", span: [5, 9] },
      { id: "b", span: [8, 8], by: ["a", "c"] },
      { id: "c", span: [8, 8], by: ["b"] },
    ];
    const out = plan(rows, { a: [5, 7] }, "overlap");
    expect(Object.keys(out).sort()).toEqual(["b", "c"]);
  });
});

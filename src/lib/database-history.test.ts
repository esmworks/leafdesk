import { describe, expect, it } from "vitest";
import {
  mergeChange,
  mergeValues,
  propertyFields,
  propertySnapshot,
  restorePatch,
  sameSnapshot,
  viewParts,
  viewSnapshot,
  type PropertySnapshot,
} from "./database-history";

const select = (options: { id: string; name: string; color?: string }[], extra: Record<string, unknown> = {}): PropertySnapshot => ({
  name: "Priority",
  type: "select",
  options: { options: options.map((o) => ({ color: "gray", ...o })), ...extra },
});

describe("propertySnapshot", () => {
  it("leaves out what is worked out on reading and where the property is pinned", () => {
    const snap = propertySnapshot({
      name: "Total",
      type: "formula",
      options: { formula: { expression: "1 + 1", type: "number" }, pinned: true },
    });
    expect(snap).toEqual({ name: "Total", type: "formula", options: { formula: { expression: "1 + 1" } } });
  });
});

describe("viewSnapshot", () => {
  it("leaves out column widths and folded groups", () => {
    const snap = viewSnapshot({ name: "All", type: "table", published: false, config: { columnWidths: { a: 100 }, collapsedGroups: ["x"], sorts: [] } });
    expect(snap.config).toEqual({ sorts: [] });
  });
});

describe("sameSnapshot", () => {
  it("ignores key order and missing keys", () => {
    expect(sameSnapshot({ a: 1, b: undefined, c: { d: 1, e: 2 } }, { c: { e: 2, d: 1 }, a: 1 })).toBe(true);
    expect(sameSnapshot({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("propertyFields", () => {
  it("names the options added, taken away, renamed and recolored", () => {
    const before = select([
      { id: "1", name: "High" },
      { id: "2", name: "Low" },
      { id: "3", name: "Mid", color: "red" },
    ]);
    const after = select([
      { id: "1", name: "Urgent" },
      { id: "3", name: "Mid", color: "blue" },
      { id: "4", name: "New" },
    ]);
    const [options] = propertyFields(before, after);
    expect(options).toEqual({
      field: "options",
      added: [{ id: "4", name: "New", color: "gray" }],
      removed: [{ id: "2", name: "Low", color: "gray" }],
      renamed: [{ from: "High", to: { id: "1", name: "Urgent", color: "gray" } }],
      recolored: [{ id: "3", name: "Mid", color: "blue" }],
    });
  });

  it("names a new name, type and settings in order", () => {
    const before: PropertySnapshot = { name: "Cost", type: "number", options: {} };
    const after: PropertySnapshot = { name: "Price", type: "text", options: { icon: "💰", description: "What it costs", number: { style: "currency", currency: "EUR" } as never } };
    expect(propertyFields(before, after)).toEqual([
      { field: "name", from: "Cost", to: "Price" },
      { field: "type", from: "number", to: "text" },
      { field: "description", from: null, to: "What it costs" },
      { field: "setting", setting: "icon" },
      { field: "setting", setting: "number" },
    ]);
  });

  it("tells a relation limited to one row from its other settings", () => {
    const relation = (extra: Record<string, unknown>) => ({ name: "Links", type: "relation" as const, options: { relation: { databaseId: "d", ...extra } } });
    expect(propertyFields(relation({}), relation({ single: true }))).toEqual([{ field: "setting", setting: "oneRow" }]);
    expect(propertyFields(relation({}), relation({ display: "section" }))).toEqual([{ field: "setting", setting: "relation" }]);
  });
});

describe("viewParts", () => {
  it("groups the settings that changed", () => {
    const before = viewSnapshot({ name: "All", type: "table", published: false, config: { filters: [], groupBy: "a" } });
    const after = viewSnapshot({ name: "Mine", type: "board", published: true, config: { filters: [{ propertyId: "p", op: "equals", value: 1 }], groupBy: "b", showWeekends: true } });
    expect(viewParts(before, after)).toEqual(["name", "layout", "filters", "groups", "published", "other"]);
  });
});

describe("mergeChange", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const open = (kind: "property_added" | "property_changed", at: Date, before: unknown = null) => ({
    id: "e1",
    kind,
    actorUserId: "u1",
    actorKind: "user" as const,
    before,
    at,
  });
  const change = { kind: "property_changed" as const, actorUserId: "u1", actorKind: "user" as const, after: { name: "B" } };

  it("merges a change into the same person's recent addition or change", () => {
    expect(mergeChange(open("property_added", new Date(now.getTime() - 60_000)), change, now)).toEqual({ action: "update", id: "e1" });
    expect(mergeChange(open("property_changed", new Date(now.getTime() - 60_000), { name: "A" }), change, now)).toEqual({ action: "update", id: "e1" });
  });

  it("drops an entry the change takes back to where it started", () => {
    expect(mergeChange(open("property_changed", new Date(now.getTime() - 60_000), { name: "B" }), change, now)).toEqual({ action: "drop", id: "e1" });
  });

  it("starts a new entry for someone else, after the window, or for a deletion", () => {
    const recent = open("property_changed", new Date(now.getTime() - 60_000), { name: "A" });
    expect(mergeChange(recent, { ...change, actorUserId: "u2" }, now)).toEqual({ action: "insert" });
    expect(mergeChange({ ...recent, at: new Date(now.getTime() - 10 * 60_000) }, change, now)).toEqual({ action: "insert" });
    expect(mergeChange(recent, { ...change, kind: "property_deleted" }, now)).toEqual({ action: "insert" });
    expect(mergeChange(recent, { ...change, actorUserId: null }, now)).toEqual({ action: "insert" });
  });
});

describe("mergeValues", () => {
  it("keeps each row's first value and its last, and drops rows back where they were", () => {
    expect(mergeValues({ r1: ["a", "b"], r2: [1, 2] }, { r1: ["b", "c"], r2: [2, 1], r3: [null, "x"] })).toEqual({ r1: ["a", "c"], r3: [null, "x"] });
  });
});

describe("restorePatch", () => {
  it("writes back only the settings that differ, in updateProperty's terms", () => {
    const current: PropertySnapshot = { name: "Price", type: "number", options: { icon: "💰", unique: true, url: undefined } };
    const target: PropertySnapshot = { name: "Cost", type: "number", options: { description: "x", person: undefined } };
    expect(restorePatch(current, target)).toEqual({ patch: { name: "Cost", description: "x", icon: null, unique: false }, kept: [] });
  });

  it("asks for a type change first, and keeps AI autofill as it is", () => {
    const { type, kept } = restorePatch(
      { name: "A", type: "text", options: { ai: { prompt: "x" } as never } },
      { name: "A", type: "number", options: {} },
    );
    expect(type).toBe("number");
    expect(kept).toEqual(["ai"]);
  });

  it("brings a date's reminder back as days before", () => {
    const { patch } = restorePatch(
      { name: "Due", type: "date", options: {} },
      { name: "Due", type: "date", options: { date: { display: "relative", reminder: { daysBefore: 2, timeZone: "Europe/Istanbul", since: "x" } } } },
    );
    expect(patch.date).toEqual({ display: "relative", format: "default", clock: "default", reminderDays: 2, timeZone: "Europe/Istanbul" });
  });
});

import { describe, expect, it } from "vitest";
import type { PropertyRule, PropertyViewer } from "./property-access";
import { makeAccess, OPEN_ACCESS } from "./property-access-rows";
import {
  changedProperties,
  coalesce,
  COALESCE_WINDOW_MS,
  readableProperties,
  referencedIds,
  resolveValue,
  sameValue,
  valueText,
  type ActivityLookups,
  type OpenEntry,
} from "./row-activity";

const now = new Date("2026-10-11T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const open = (over: Partial<OpenEntry> = {}): OpenEntry => ({
  id: "e1",
  actorUserId: "u1",
  actorKind: "user",
  oldValue: "a",
  at: ago(60_000),
  ...over,
});

describe("changedProperties", () => {
  const props = [
    { id: "notes", type: "text" as const },
    { id: "tags", type: "multi_select" as const },
    { id: "double", type: "formula" as const },
    { id: "edited", type: "last_edited_time" as const },
  ];

  it("lists the stored values that changed, nothing being the same however written", () => {
    const changes = changedProperties({ notes: "a", tags: [] }, { notes: "b", tags: null, double: 4, edited: "x" }, props);
    expect(changes).toEqual([{ propertyId: "notes", propertyType: "text", oldValue: "a", newValue: "b" }]);
  });

  it("counts an unticked checkbox as never ticked", () => {
    const box = [{ id: "done", type: "checkbox" as const }];
    expect(changedProperties({}, { done: false }, box)).toEqual([]);
    expect(changedProperties({ done: true }, { done: false }, box)).toEqual([
      { propertyId: "done", propertyType: "checkbox", oldValue: true, newValue: null },
    ]);
  });

  it("stores nothing as null", () => {
    expect(changedProperties({}, { tags: ["o1"] }, props)).toEqual([
      { propertyId: "tags", propertyType: "multi_select", oldValue: null, newValue: ["o1"] },
    ]);
    expect(sameValue(undefined, "")).toBe(true);
    expect(sameValue([], null)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(false, null)).toBe(false);
  });
});

describe("coalesce", () => {
  const change = { actorUserId: "u1", actorKind: "user" as const, newValue: "abc" };

  it("starts an entry when there is none", () => {
    expect(coalesce(null, change, now)).toEqual({ action: "insert" });
  });

  it("merges a quick change by the same actor", () => {
    expect(coalesce(open(), change, now)).toEqual({ action: "update", id: "e1" });
    expect(coalesce(open({ at: ago(COALESCE_WINDOW_MS) }), change, now)).toEqual({ action: "update", id: "e1" });
  });

  it("keeps changes apart after the window, by someone else, or by another kind of actor", () => {
    expect(coalesce(open({ at: ago(COALESCE_WINDOW_MS + 1) }), change, now)).toEqual({ action: "insert" });
    expect(coalesce(open({ actorUserId: "u2" }), change, now)).toEqual({ action: "insert" });
    expect(coalesce(open({ actorKind: "automation" }), change, now)).toEqual({ action: "insert" });
  });

  it("never merges changes nobody is named for", () => {
    expect(coalesce(open({ actorUserId: null }), { ...change, actorUserId: null }, now)).toEqual({ action: "insert" });
  });

  it("drops the entry when the value is back where it started", () => {
    expect(coalesce(open({ oldValue: "abc" }), change, now)).toEqual({ action: "drop", id: "e1" });
    expect(coalesce(open({ oldValue: null }), { ...change, newValue: "" }, now)).toEqual({ action: "drop", id: "e1" });
  });
});

describe("resolveValue", () => {
  const options = [
    { id: "o1", name: "In progress", color: "blue" },
    { id: "o2", name: "Done", color: "green" },
  ];
  const lookups: ActivityLookups = {
    people: new Map([["u1", { id: "u1", name: "Ayşe", image: null }]]),
    pages: new Map([["p1", { title: "Spec", icon: "📄" }]]),
  };

  it("reads options by name and color, counting the ones gone", () => {
    expect(resolveValue("status", options, "o2", lookups)).toEqual({ type: "options", options: [{ name: "Done", color: "green" }], missing: 0 });
    expect(resolveValue("multi_select", options, ["o1", "gone"], lookups)).toEqual({
      type: "options",
      options: [{ name: "In progress", color: "blue" }],
      missing: 1,
    });
  });

  it("names people and the linked rows the viewer can open, and no others", () => {
    expect(resolveValue("person", [], ["u1", "u9"], lookups)).toEqual({
      type: "people",
      people: [{ id: "u1", name: "Ayşe", image: null }],
      missing: 1,
    });
    const pages = resolveValue("relation", [], ["p1", "p2"], lookups);
    expect(pages).toEqual({ type: "pages", pages: [{ id: "p1", title: "Spec", icon: "📄" }, { id: "p2", noAccess: true }] });
    expect(JSON.stringify(pages)).not.toContain("Hidden");
  });

  it("reads dates, checkboxes, files and checklists", () => {
    expect(resolveValue("date", [], "2026-10-12", lookups)).toEqual({ type: "date", value: "2026-10-12" });
    expect(resolveValue("checkbox", [], true, lookups)).toEqual({ type: "checkbox", checked: true });
    expect(resolveValue("checkbox", [], null, lookups)).toEqual({ type: "checkbox", checked: false });
    expect(resolveValue("files", [], [{ url: "/api/files/x", name: "plan.pdf", type: "application/pdf" }], lookups)).toEqual({
      type: "files",
      names: ["plan.pdf"],
    });
    const checklist = [
      { id: "1", text: "a", checked: true },
      { id: "2", text: "b", checked: false },
    ];
    expect(resolveValue("checklist", [], checklist, lookups)).toEqual({ type: "checklist", done: 1, total: 2 });
  });

  it("falls back to text for values shaped otherwise", () => {
    expect(resolveValue("number", [], "12", lookups)).toEqual({ type: "text", text: "12" });
    expect(resolveValue(null, [], 5, lookups)).toEqual({ type: "number", value: 5 });
    expect(resolveValue("date", [], { start: "x" }, lookups)).toEqual({ type: "text", text: '{"start":"x"}' });
  });

  it("collects the ids to look up", () => {
    const ids = referencedIds([
      { type: "person", value: ["u1", "u2"] },
      { type: "relation", value: ["p1"] },
      { type: "text", value: "u3" },
    ]);
    expect([...ids.people]).toEqual(["u1", "u2"]);
    expect([...ids.pages]).toEqual(["p1"]);
  });

  it("words values for MCP and the API", () => {
    expect(valueText(resolveValue("multi_select", options, ["o1", "gone"], lookups))).toBe("In progress, (deleted option)");
    expect(valueText(resolveValue("relation", [], ["p1", "p2"], lookups))).toBe("Spec, (no access)");
    expect(valueText(resolveValue("checkbox", [], false, lookups))).toBe("unchecked");
    expect(valueText({ type: "empty" })).toBeNull();
  });
});

describe("readableProperties", () => {
  const rule = (level: PropertyRule["level"], over: Partial<PropertyRule> = {}): PropertyRule => ({
    propertyId: "salary",
    userId: null,
    groupId: null,
    personPropertyId: null,
    level,
    ...over,
  });
  const viewer: PropertyViewer = { userId: "u1", groupIds: [], databaseLevel: "edit" };
  const props = [
    { id: "salary", name: "Salary", type: "number" as const, options: {}, deletedAt: null },
    { id: "notes", name: "Notes", type: "text" as const, options: {}, deletedAt: null },
    { id: "owner", name: "Owner", type: "person" as const, options: {}, deletedAt: null },
    { id: "old", name: "Old", type: "text" as const, options: {}, deletedAt: new Date() },
  ];

  it("leaves out deleted properties", () => {
    expect([...readableProperties(props, OPEN_ACCESS, { properties: {} })]).toEqual(["salary", "notes", "owner"]);
  });

  it("leaves out properties whose values the viewer may not see in the row", () => {
    for (const level of ["none", "view_property"] as const) {
      const access = makeAccess(new Map([["salary", [rule(level)]]]), viewer, props);
      expect([...readableProperties(props, access, { properties: {} })]).toEqual(["notes", "owner"]);
    }
    const viewOnly = makeAccess(new Map([["salary", [rule("view")]]]), viewer, props);
    expect(readableProperties(props, viewOnly, { properties: {} }).has("salary")).toBe(true);
  });

  it("goes by the row for exceptions that depend on it", () => {
    const access = makeAccess(new Map([["salary", [rule("none"), rule("view", { personPropertyId: "owner" })]]]), viewer, props);
    expect(readableProperties(props, access, { properties: { owner: ["u1"] } }).has("salary")).toBe(true);
    expect(readableProperties(props, access, { properties: { owner: ["u2"] } }).has("salary")).toBe(false);
  });

  it("keeps everything for full access", () => {
    const access = makeAccess(new Map([["salary", [rule("none")]]]), { ...viewer, databaseLevel: "full" }, props);
    expect(readableProperties(props, access, { properties: {} }).has("salary")).toBe(true);
  });
});

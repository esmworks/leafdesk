import { describe, expect, it } from "vitest";
import { checkRelationOptions, linksOne, MAX_RELATION_SHOW, shownParts, shownPropertyIds, showableType } from "./relation-options";

const base = { databaseId: "db-2" };
const targets = [
  { id: "status", name: "Status", type: "status" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "due", name: "Due", type: "date" },
  { id: "total", name: "Total", type: "formula" },
  { id: "a", name: "A", type: "text" },
  { id: "b", name: "B", type: "number" },
];

describe("relation options", () => {
  it("limits to one row and back", () => {
    const one = checkRelationOptions({ limit: "one" }, base, targets);
    expect(one).toEqual({ ok: true, relation: { databaseId: "db-2", limit: "one" } });
    expect(linksOne(one.ok ? one.relation : null)).toBe(true);
    expect(checkRelationOptions({ limit: "any" }, { ...base, limit: "one" }, targets)).toEqual({ ok: true, relation: base });
    expect(checkRelationOptions({ limit: null }, { ...base, limit: "one" }, targets)).toEqual({ ok: true, relation: base });
    expect(linksOne({ ...base, role: "parent" })).toBe(true);
    expect(linksOne(base)).toBe(false);
  });

  it("shows as a section or inline, keeping the other options", () => {
    expect(checkRelationOptions({ display: "section" }, { ...base, limit: "one" }, targets)).toEqual({
      ok: true,
      relation: { databaseId: "db-2", limit: "one", display: "section" },
    });
    expect(checkRelationOptions({ display: "inline" }, { ...base, display: "section" }, targets)).toEqual({ ok: true, relation: base });
  });

  it("keeps the order of what linked rows show, without repeats, the title included", () => {
    expect(checkRelationOptions({ show: ["status", "title", "status", "due"] }, base, targets)).toEqual({
      ok: true,
      relation: { ...base, show: ["status", "title", "due"] },
    });
    expect(checkRelationOptions({ show: ["owner"] }, base, targets)).toEqual({ ok: true, relation: { ...base, show: ["owner", "title"] } });
    expect(checkRelationOptions({ show: ["title"] }, { ...base, show: ["owner", "title"] }, targets)).toEqual({ ok: true, relation: base });
    expect(checkRelationOptions({ show: null }, { ...base, show: ["owner", "title"] }, targets)).toEqual({ ok: true, relation: base });
  });

  it("refuses unknown, unshowable and too many properties, and bad values", () => {
    expect(checkRelationOptions({ show: ["nope"] }, base, targets).ok).toBe(false);
    expect(checkRelationOptions({ show: ["total"] }, base, targets).ok).toBe(false);
    expect(checkRelationOptions({ show: ["status", "owner", "due", "a", "b"] }, base, targets).ok).toBe(false);
    expect(checkRelationOptions({ limit: "two" as never }, base, targets).ok).toBe(false);
    expect(checkRelationOptions({ display: "page" as never }, base, targets).ok).toBe(false);
    expect(checkRelationOptions({ show: [1] as never }, base, targets).ok).toBe(false);
    expect(MAX_RELATION_SHOW).toBe(4);
  });

  it("skips the property check without the related properties", () => {
    expect(checkRelationOptions({ show: ["anything"] }, base, null)).toEqual({ ok: true, relation: { ...base, show: ["anything", "title"] } });
  });

  it("reads what a linked row shows", () => {
    expect(shownParts(base)).toEqual(["title"]);
    expect(shownParts({ ...base, show: ["status", "title"] })).toEqual(["status", "title"]);
    expect(shownPropertyIds({ ...base, show: ["status", "title", "due"] })).toEqual(["status", "due"]);
    expect(showableType("files")).toBe(false);
    expect(showableType("rollup")).toBe(false);
    expect(showableType("person")).toBe(true);
  });
});

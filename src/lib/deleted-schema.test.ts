import { describe, expect, it } from "vitest";
import type { FilterEntry, ViewConfig } from "@/db/schema/app";
import { keepDeleted, livePropertyValues, uniqueName, withoutDeleted } from "./deleted-schema";

const deleted = new Set(["gone"]);

const nested: FilterEntry[] = [
  { propertyId: "status", op: "equals", value: "Done" },
  {
    type: "group",
    combinator: "or",
    rules: [
      { propertyId: "gone", op: "is_not_empty" },
      { propertyId: "tags", op: "contains", value: "x" },
    ],
  },
  { type: "group", combinator: "and", rules: [{ propertyId: "gone", op: "gt", value: 3 }] },
];

describe("livePropertyValues", () => {
  it("drops values of properties that aren't live", () => {
    expect(livePropertyValues({ a: 1, gone: 2 }, [{ id: "a" }])).toEqual({ a: 1 });
  });

  it("returns the same object when nothing is stale", () => {
    const values = { a: 1 };
    expect(livePropertyValues(values, [{ id: "a" }, { id: "b" }])).toBe(values);
  });
});

describe("uniqueName", () => {
  it("keeps a free name", () => {
    expect(uniqueName("Estimate", ["Notes"])).toBe("Estimate");
  });

  it("numbers a name taken without regard to case or spaces", () => {
    expect(uniqueName("Estimate", [" estimate "])).toBe("Estimate 2");
    expect(uniqueName("Estimate", ["Estimate", "Estimate 2"])).toBe("Estimate 3");
  });

  it("never gives a property the row's title name", () => {
    expect(uniqueName("Title", [])).toBe("Title 2");
  });
});

describe("withoutDeleted", () => {
  it("leaves settings alone when nothing is deleted", () => {
    const config: ViewConfig = { sorts: [{ propertyId: "gone", direction: "asc" }] };
    expect(withoutDeleted(config, new Set())).toBe(config);
  });

  it("ignores deleted properties rule by rule, dropping groups left empty", () => {
    const out = withoutDeleted(
      {
        filters: nested,
        sorts: [
          { propertyId: "gone", direction: "asc" },
          { propertyId: "status", direction: "desc" },
        ],
        groupBy: "gone",
      },
      deleted,
    );
    expect(out.filters).toEqual([
      { propertyId: "status", op: "equals", value: "Done" },
      { type: "group", combinator: "or", rules: [{ propertyId: "tags", op: "contains", value: "x" }] },
    ]);
    expect(out.sorts).toEqual([{ propertyId: "status", direction: "desc" }]);
    expect(out.groupBy).toBeUndefined();
  });
});

describe("keepDeleted", () => {
  it("passes new settings through when nothing is deleted", () => {
    const next: ViewConfig = { filters: [] };
    expect(keepDeleted({ filters: nested }, next, new Set())).toBe(next);
  });

  it("keeps stored filters exactly when they weren't changed", () => {
    const stored: ViewConfig = { filters: nested, sorts: [{ propertyId: "gone", direction: "asc" }] };
    const shown = withoutDeleted(stored, deleted);
    const out = keepDeleted(stored, { ...shown, showTable: true }, deleted);
    expect(out.filters).toEqual(nested);
    expect(out.showTable).toBe(true);
    expect(out.sorts).toEqual([{ propertyId: "gone", direction: "asc" }]);
  });

  it("adds deleted rules back at the top level when the filters changed", () => {
    const out = keepDeleted({ filters: nested }, { filters: [{ propertyId: "tags", op: "is_empty" }] }, deleted);
    expect(out.filters).toEqual([
      { propertyId: "tags", op: "is_empty" },
      { propertyId: "gone", op: "is_not_empty" },
      { propertyId: "gone", op: "gt", value: 3 },
    ]);
  });

  it("puts back a deleted property's grouping", () => {
    const out = keepDeleted({ groupBy: "gone" }, { groupBy: undefined, showTable: false }, deleted);
    expect(out.groupBy).toBe("gone");
  });
});

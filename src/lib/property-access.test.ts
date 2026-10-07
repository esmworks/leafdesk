import { describe, expect, it } from "vitest";
import type { ViewConfig } from "@/db/schema";
import { canRestrict, databaseCap, dependsOnRow, resolvePropertyLevel, type PropertyRule, type PropertyViewer } from "./property-access";
import { hideReferences, makeAccess, restoreReferences } from "./property-access-rows";
import { PropertyValueError } from "./properties";

const rule = (level: PropertyRule["level"], who: Partial<Pick<PropertyRule, "userId" | "groupId" | "personPropertyId">> = {}): PropertyRule => ({
  propertyId: "salary",
  userId: null,
  groupId: null,
  personPropertyId: null,
  level,
  ...who,
});
const viewer = (over: Partial<PropertyViewer> = {}): PropertyViewer => ({
  userId: "u1",
  groupIds: [],
  databaseLevel: "edit",
  ...over,
});

describe("resolvePropertyLevel", () => {
  it("follows the database without rules", () => {
    expect(resolvePropertyLevel([], viewer())).toBe("edit");
    expect(resolvePropertyLevel([], viewer({ databaseLevel: "comment" }))).toBe("view");
    expect(resolvePropertyLevel([], viewer({ databaseLevel: "none" }))).toBe("none");
  });

  it("applies the entry for everyone", () => {
    expect(resolvePropertyLevel([rule("none")], viewer())).toBe("none");
    expect(resolvePropertyLevel([rule("view_property")], viewer())).toBe("view_property");
  });

  it("never restricts full access", () => {
    expect(resolvePropertyLevel([rule("none")], viewer({ databaseLevel: "full" }))).toBe("edit");
  });

  it("takes the widest matching exception", () => {
    const rules = [rule("none"), rule("view", { userId: "u1" }), rule("edit_values", { groupId: "g1" }), rule("edit", { userId: "u2" })];
    expect(resolvePropertyLevel(rules, viewer())).toBe("view");
    expect(resolvePropertyLevel(rules, viewer({ groupIds: ["g1"] }))).toBe("edit_values");
    expect(resolvePropertyLevel(rules, viewer({ userId: "u3" }))).toBe("none");
  });

  it("never goes past the database access", () => {
    expect(resolvePropertyLevel([rule("none"), rule("edit", { userId: "u1" })], viewer({ databaseLevel: "view" }))).toBe("view");
  });

  it("matches person property exceptions per row, never beyond values", () => {
    const rules = [rule("none"), rule("edit", { personPropertyId: "owner" })];
    expect(resolvePropertyLevel(rules, viewer(), { owner: ["u1"] })).toBe("edit_values");
    expect(resolvePropertyLevel(rules, viewer(), { owner: ["u2"] })).toBe("none");
    expect(resolvePropertyLevel(rules, viewer(), null)).toBe("none");
    // Without a row: the most any row could give.
    expect(resolvePropertyLevel(rules, viewer())).toBe("edit_values");
    expect(dependsOnRow(rules, viewer())).toBe(true);
    expect(dependsOnRow([rule("none"), rule("view", { userId: "u1" })], viewer())).toBe(false);
  });

  it("knows what can't be restricted", () => {
    expect(canRestrict("number")).toBe(true);
    expect(canRestrict("formula")).toBe(true);
    expect(canRestrict("relation")).toBe(false);
    expect(canRestrict("created_by")).toBe(false);
    expect(canRestrict("last_edited_time")).toBe(false);
    expect(databaseCap("full")).toBe("edit");
  });
});

const props = [
  { id: "salary", name: "Salary", type: "number" as const, options: {} },
  { id: "notes", name: "Notes", type: "text" as const, options: {} },
  { id: "secret", name: "Secret", type: "text" as const, options: {} },
  { id: "owner", name: "Owner", type: "person" as const, options: {} },
  { id: "yearly", name: "Yearly", type: "formula" as const, options: { formula: { expression: 'prop("salary") * 12' } } },
  { id: "double", name: "Double", type: "formula" as const, options: { formula: { expression: 'prop("yearly") * 2' } } },
];
const rules = new Map<string, PropertyRule[]>([
  ["salary", [rule("view_property"), rule("edit_values", { personPropertyId: "owner" })]],
  ["secret", [{ ...rule("none"), propertyId: "secret" }]],
]);

describe("makeAccess", () => {
  const access = makeAccess(rules, viewer(), props);

  it("hides properties at none from the schema and tells the level of the others", () => {
    expect(access.visible(props).map((p) => p.id)).toEqual(["salary", "notes", "owner", "yearly", "double"]);
    expect(access.info()).toEqual({ salary: { level: "edit_values", perRow: true } });
  });

  it("leaves hidden values out, with formulas that read them", () => {
    const rows = [
      { properties: { salary: 100, notes: "a", secret: "s", owner: ["u2"], yearly: 1200, double: 2400 } },
      { properties: { salary: 200, notes: "b", secret: "t", owner: ["u1"], yearly: 2400, double: 4800 } },
    ];
    const [other, own] = access.finish(access.strip(rows));
    expect(other.properties).toEqual({ notes: "a", owner: ["u2"] });
    expect(new Set(other.hidden)).toEqual(new Set(["salary", "yearly", "double"]));
    expect(own.properties).toEqual({ salary: 200, notes: "b", owner: ["u1"], yearly: 2400, double: 4800 });
    expect(own.hidden).toBeUndefined();
  });

  it("refuses writes the viewer may not make", () => {
    expect(() => access.requireValues({ properties: { owner: ["u2"] } }, ["salary"])).toThrow(PropertyValueError);
    expect(() => access.requireValues({ properties: { owner: ["u1"] } }, ["salary", "notes"])).not.toThrow();
    expect(() => access.requireValues(null, ["secret"])).toThrow(/Unknown property/);
    expect(() => access.requireSchema("salary")).toThrow(PropertyValueError);
    expect(() => access.requireSchema("notes")).not.toThrow();
  });

  it("counts the creator for created-by exceptions", () => {
    const withCreator = [...props, { id: "creator", name: "Created by", type: "created_by" as const, options: {} }];
    const a = makeAccess(new Map([["salary", [rule("none"), rule("view", { personPropertyId: "creator" })]]]), viewer(), withCreator);
    expect(a.levelOf("salary", { properties: {}, createdBy: "u1" })).toBe("view");
    expect(a.levelOf("salary", { properties: {}, createdBy: "u2" })).toBe("none");
  });

  it("is open for full access", () => {
    const full = makeAccess(rules, viewer({ databaseLevel: "full" }), props);
    expect(full.open).toBe(true);
    expect(full.visible(props)).toHaveLength(props.length);
  });
});

describe("view references", () => {
  const stored: ViewConfig = {
    groupBy: "secret",
    sorts: [
      { propertyId: "notes", direction: "asc" },
      { propertyId: "secret", direction: "desc" },
    ],
    filters: [
      { propertyId: "notes", op: "contains", value: "x" },
      { type: "group", combinator: "or", rules: [{ propertyId: "secret", op: "is_not_empty" }, { propertyId: "notes", op: "is_empty" }] },
    ],
    hidden: ["secret"],
    wrapped: ["secret", "notes"],
    frozenThrough: "secret",
    calculations: { secret: "count_values" },
  } as ViewConfig;
  const gone = new Set(["secret"]);

  it("leaves out what refers to unknown properties, groups whole", () => {
    const shown = hideReferences(stored, gone);
    expect(shown.groupBy).toBeUndefined();
    expect(shown.sorts).toEqual([{ propertyId: "notes", direction: "asc" }]);
    expect(shown.filters).toEqual([{ propertyId: "notes", op: "contains", value: "x" }]);
    expect(shown.hidden).toEqual([]);
    expect(shown.wrapped).toEqual(["notes"]);
    expect(shown.frozenThrough).toBeUndefined();
    expect(shown.calculations).toEqual({});
  });

  it("puts them back when the view is saved", () => {
    const edited: ViewConfig = { ...hideReferences(stored, gone), sorts: [] };
    const saved = restoreReferences(stored, edited, gone);
    expect(saved.groupBy).toBe("secret");
    expect(saved.sorts).toEqual([{ propertyId: "secret", direction: "desc" }]);
    expect(saved.filters).toEqual(stored.filters);
    expect(saved.hidden).toEqual(["secret"]);
    expect(saved.wrapped).toEqual(["notes", "secret"]);
    expect(saved.frozenThrough).toBe("secret");
    expect(saved.calculations).toEqual({ secret: "count_values" });
  });

  it("keeps a hidden column where it was when the saver reorders the others", () => {
    expect(restoreReferences({ columnWidths: { secret: 90, a: 100 } }, { columnWidths: { a: 150 } }, gone).columnWidths).toEqual({
      a: 150,
      secret: 90,
    });
    const order = { propertyOrder: ["a", "secret", "b", "c"] } as ViewConfig;
    expect(hideReferences(order, gone).propertyOrder).toEqual(["a", "b", "c"]);
    // The saver moved c to the front: secret stays right after a.
    expect(restoreReferences(order, { propertyOrder: ["c", "a", "b"] }, gone).propertyOrder).toEqual(["c", "a", "secret", "b"]);
    expect(restoreReferences({ propertyOrder: ["secret", "a"] }, { propertyOrder: ["a"] }, gone).propertyOrder).toEqual(["secret", "a"]);
  });
});

import { describe, expect, it } from "vitest";
import type { ColorRule, PropertyOptions, ViewConfig } from "@/db/schema/app";
import {
  colorRows,
  colorRulesConfigError,
  dropColorRules,
  MAX_COLOR_RULES,
  restoreColorRules,
  type RowColors,
} from "./color-rules";
import { retypeViewConfig } from "./convert-property";
import { keepDeleted, withoutDeleted } from "./deleted-schema";
import { dropPropertyReferences, remapViewConfig } from "./duplicate";
import { applyView } from "./properties";
import type { PropertyRule, PropertyViewer } from "./property-access";
import { hideReferences, makeAccess, restoreReferences } from "./property-access-rows";
import type { PropertyType } from "./property-types";
import { layoutConfigError } from "./views";

const prop = (id: string, type: PropertyType, options: PropertyOptions = {}) => ({ id, name: id, type, options });
const props = [
  prop("status", "select", { options: [{ id: "done", name: "Done", color: "green" }, { id: "late", name: "Late", color: "red" }] }),
  prop("amount", "number"),
  prop("owner", "person"),
  prop("due", "date"),
  prop("total", "formula", { formula: { expression: 'prop("amount") * 2' } }),
  prop("secret", "text"),
];
const row = (id: string, properties: Record<string, unknown>, title = id) => ({
  id,
  title,
  properties,
  createdAt: new Date("2026-01-01T10:00:00Z"),
  updatedAt: new Date("2026-01-02T10:00:00Z"),
});
const rows = [
  row("a", { status: "done", amount: 5, total: 10, owner: ["u1"] }),
  row("b", { status: "late", amount: 50, total: 100, owner: ["u2"] }),
  row("c", { amount: 500, total: 1000 }),
];
const rule = (id: string, over: Partial<ColorRule>): ColorRule => ({ id, color: "red", filters: [], ...over });

describe("colorRows", () => {
  it("colors each target with the first rule that matches", () => {
    const colors = colorRows(
      rows,
      [
        rule("r1", { color: "green", filters: [{ propertyId: "status", op: "equals", value: "done" }] }),
        rule("r2", { color: "red", filters: [{ propertyId: "amount", op: "gte", value: 10 }] }),
        rule("r3", { color: "blue", filters: [{ propertyId: "amount", op: "gt", value: 0 }] }),
        rule("c1", { color: "yellow", propertyId: "amount", filters: [{ propertyId: "amount", op: "gt", value: 100 }] }),
        rule("c2", { color: "purple", propertyId: "title", filters: [{ propertyId: "title", op: "contains", value: "b" }] }),
      ],
      props,
    );
    expect(colors.get("a")).toEqual({ row: "green" });
    expect(colors.get("b")).toEqual({ row: "red", cells: { title: "purple" } });
    expect(colors.get("c")).toEqual({ row: "red", cells: { amount: "yellow" } });
  });

  it("tests rows exactly as the view's filters do: formulas, people and dates", () => {
    const cases: ColorRule["filters"][] = [
      [{ propertyId: "total", op: "gt", value: 50 }],
      [{ propertyId: "owner", op: "contains", value: "me" }],
      [{ propertyId: "status", op: "is_any_of", value: ["done", "late"] }],
      [{ propertyId: "created_at", op: "is_within", value: "this_month" }],
      [
        { propertyId: "amount", op: "lt", value: 100 },
        { type: "group", combinator: "or", rules: [{ propertyId: "status", op: "is_empty" }, { propertyId: "owner", op: "contains", value: "u2" }] },
      ],
    ];
    const viewer = { viewerId: "u1", now: new Date("2026-01-15T12:00:00Z"), timeZone: "UTC" };
    for (const filters of cases) {
      const colored = [...colorRows(rows, [rule("r", { filters })], props, viewer).keys()];
      const filtered = applyView(rows, { filters }, props, viewer).map((r) => r.id);
      expect(colored).toEqual(filtered);
    }
  });

  it("colors nothing for a rule without a complete condition, a bad color or an unknown target", () => {
    expect(colorRows(rows, [rule("r", { filters: [] })], props).size).toBe(0);
    expect(colorRows(rows, [rule("r", { filters: [{ propertyId: "status", op: "equals" }] })], props).size).toBe(0);
    const any = [{ propertyId: "amount", op: "gt" as const, value: 0 }];
    expect(colorRows(rows, [rule("r", { color: "teal", filters: any })], props).size).toBe(0);
    expect(colorRows(rows, [rule("r", { propertyId: "gone", filters: any })], props).size).toBe(0);
  });

  it("keeps the entries of rows colored as before", () => {
    const rules = [rule("r", { filters: [{ propertyId: "amount", op: "gt", value: 10 }] })];
    const first = colorRows(rows, rules, props);
    const changed = [rows[0], { ...rows[1], properties: { ...rows[1].properties, amount: 1 } }, rows[2]];
    const second = colorRows(changed, rules, props, {}, first);
    expect(second.get("b")).toBeUndefined();
    expect(second.get("c")).toBe(first.get("c") as RowColors);
  });
});

describe("colorRulesConfigError", () => {
  const ok = [rule("r1", { color: "green", propertyId: "amount", filters: [{ propertyId: "amount", op: "gt", value: 1 }] })];

  it("takes well-formed rules", () => {
    expect(colorRulesConfigError(undefined)).toBeNull();
    expect(colorRulesConfigError(ok)).toBeNull();
    expect(layoutConfigError({ colorRules: ok })).toBeNull();
  });

  it("refuses malformed ones", () => {
    expect(colorRulesConfigError({})).toMatch(/list/);
    expect(colorRulesConfigError([{ ...ok[0], id: "bad id!" }])).toMatch(/id/);
    expect(colorRulesConfigError([ok[0], ok[0]])).toMatch(/Two color rules/);
    expect(colorRulesConfigError([{ ...ok[0], color: "teal" }])).toMatch(/color must be/);
    expect(colorRulesConfigError([{ ...ok[0], propertyId: 4 }])).toMatch(/propertyId/);
    expect(colorRulesConfigError([{ ...ok[0], filters: "x" }])).toMatch(/filters must be a list/);
    expect(colorRulesConfigError([{ ...ok[0], filters: [{ propertyId: "a", op: "near" }] }])).toMatch(/Unknown filter operator/);
    expect(colorRulesConfigError([{ ...ok[0], filterCombinator: "xor" }])).toMatch(/combinator/);
    expect(colorRulesConfigError([{ ...ok[0], style: "bold" }])).toMatch(/unknown setting "style"/);
    const many = Array.from({ length: MAX_COLOR_RULES + 1 }, (_, i) => ({ ...ok[0], id: `r${i}` }));
    expect(colorRulesConfigError(many)).toMatch(/at most/);
    expect(layoutConfigError({ colorRules: [{ ...ok[0], color: "teal" }] } as ViewConfig)).toMatch(/color must be/);
  });
});

const stored: ViewConfig = {
  colorRules: [
    rule("open", { color: "green", filters: [{ propertyId: "status", op: "equals", value: "done" }] }),
    rule("hiddenCondition", {
      filters: [{ type: "group", combinator: "or", rules: [{ propertyId: "amount", op: "gt", value: 1 }, { propertyId: "secret", op: "is_not_empty" }] }],
    }),
    rule("hiddenTarget", { color: "blue", propertyId: "secret", filters: [{ propertyId: "amount", op: "gt", value: 1 }] }),
    rule("last", { color: "pink", propertyId: "amount", filters: [{ propertyId: "amount", op: "gt", value: 9 }] }),
  ],
};
const ids = (config: ViewConfig) => config.colorRules?.map((r) => r.id);

describe("color rules and property access", () => {
  const accessRule = (level: PropertyRule["level"]): PropertyRule => ({
    propertyId: "secret",
    userId: null,
    groupId: null,
    personPropertyId: null,
    level,
  });
  const viewer: PropertyViewer = { userId: "u1", groupIds: [], databaseLevel: "edit" };
  const access = makeAccess(new Map([["secret", [accessRule("none")]]]), viewer, props);

  it("drops, for a viewer who can't know a property, every rule that names it", () => {
    expect(ids(access.viewConfig(stored))).toEqual(["open", "last"]);
    expect(ids(hideReferences(stored, new Set(["secret"])))).toEqual(["open", "last"]);
    // Full access sees them all.
    const full = makeAccess(new Map([["secret", [accessRule("none")]]]), { ...viewer, databaseLevel: "full" }, props);
    expect(ids(full.viewConfig(stored))).toEqual(ids(stored));
  });

  it("puts them back, in their places, when that viewer saves the view", () => {
    const gone = new Set(["secret"]);
    const shown = hideReferences(stored, gone);
    // They reorder the rules they see and delete none: the hidden ones stay right after "open".
    const edited: ViewConfig = { ...shown, colorRules: [...shown.colorRules!].reverse() };
    expect(ids(restoreReferences(stored, edited, gone))).toEqual(["last", "open", "hiddenCondition", "hiddenTarget"]);
    // Deleting one they see keeps the others.
    const removed: ViewConfig = { ...shown, colorRules: shown.colorRules!.filter((r) => r.id !== "open") };
    expect(ids(restoreReferences(stored, removed, gone))).toEqual(["hiddenCondition", "hiddenTarget", "last"]);
    expect(restoreReferences(stored, removed, gone).colorRules![0]).toEqual(stored.colorRules![1]);
  });
});

describe("color rules and the schema", () => {
  it("drop whole when a property they name is deleted, and come back on saving while it is", () => {
    const deleted = new Set(["secret"]);
    expect(ids(dropPropertyReferences(stored, (id) => deleted.has(id)))).toEqual(["open", "last"]);
    const shown = withoutDeleted(stored, deleted);
    const saved = keepDeleted(stored, { ...shown, colorRules: shown.colorRules!.slice(1) }, deleted);
    expect(ids(saved)).toEqual(["hiddenCondition", "hiddenTarget", "last"]);
    expect(dropColorRules(undefined, () => true)).toBeUndefined();
  });

  it("follow a copy to its properties and rows", () => {
    const config: ViewConfig = {
      colorRules: [rule("r", { propertyId: "status", filters: [{ propertyId: "link", op: "contains", value: "row1" }, { propertyId: "status", op: "equals", value: "done" }] })],
    };
    const copied = remapViewConfig(config, new Map([["status", "status2"], ["link", "link2"]]), (id) => (id === "link" ? new Map([["row1", "row9"]]) : null));
    expect(copied.colorRules).toEqual([
      rule("r", { propertyId: "status2", filters: [{ propertyId: "link2", op: "contains", value: "row9" }, { propertyId: "status2", op: "equals", value: "done" }] }),
    ]);
  });

  it("drop rules testing a property whose type changes, and keep those coloring it", () => {
    const config: ViewConfig = {
      colorRules: [
        rule("tests", { filters: [{ propertyId: "amount", op: "gt", value: 1 }] }),
        rule("colors", { propertyId: "amount", filters: [{ propertyId: "status", op: "is_not_empty" }] }),
      ],
    };
    const retyped = retypeViewConfig(config, "amount", "number", { type: "text", options: {} });
    expect(ids(retyped)).toEqual(["colors"]);
  });

  it("restore nothing when no stored rule names a gone property", () => {
    const next = [rule("x", {})];
    expect(restoreColorRules(stored.colorRules, next, () => false)).toBe(next);
  });
});

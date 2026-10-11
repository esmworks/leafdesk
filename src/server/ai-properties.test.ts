import { beforeEach, describe, expect, it, vi } from "vitest";
import { restrictedProperties } from "@/lib/property-access";

/**
 * What AI autofill leaves out of its input besides the row's own restricted properties: rollups
 * over a restricted property of related rows (and, through the closure in runJob, formulas reading
 * those rollups). The related databases' schemas and rules come from the maps below.
 */
type Prop = { id: string; databaseId: string; name: string; type: string; options: Record<string, unknown> };
const schemas = new Map<string, Prop[]>();
const rules = new Map<string, unknown[]>();

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/row-events", () => ({ onRowChanged: vi.fn() }));
vi.mock("@/server/derived", () => ({
  loadProperties: async (ids: string[]) => new Map(ids.flatMap((id) => (schemas.has(id) ? [[id, schemas.get(id)!]] : []))),
  relatedSchemasFor: async () => (id: string) => schemas.get(id),
}));
vi.mock("@/server/property-access", () => ({
  loadPropertyRules: async (ids: string[]) =>
    new Map([...rules].filter(([propertyId]) => [...schemas].some(([db, props]) => ids.includes(db) && props.some((p) => p.id === propertyId)))),
  propertyAccessFor: vi.fn(),
}));

const { rollupsOverRestricted } = await import("./ai-properties");

const prop = (databaseId: string, id: string, type: string, options: Record<string, unknown> = {}): Prop => ({ id, databaseId, name: id, type, options });
const relation = (databaseId: string, id: string, target: string) => prop(databaseId, id, "relation", { relation: { databaseId: target } });
const rollup = (databaseId: string, id: string, relationPropertyId: string, targetPropertyId: string) =>
  prop(databaseId, id, "rollup", { rollup: { relationPropertyId, targetPropertyId, function: "show_original" } });

beforeEach(() => {
  schemas.clear();
  rules.clear();
});

describe("rollupsOverRestricted", () => {
  it("leaves out a rollup over a property with rules in the related database", async () => {
    schemas.set("salaries", [prop("salaries", "amount", "number"), prop("salaries", "team", "text")]);
    rules.set("amount", [{ level: "view_property" }]);
    const staff = [relation("staff", "pay", "salaries"), rollup("staff", "payAmount", "pay", "amount"), rollup("staff", "payTeam", "pay", "team")];
    expect(await rollupsOverRestricted(staff as never)).toEqual(["payAmount"]);
  });

  it("…and one over a formula there reading such a property", async () => {
    schemas.set("salaries", [prop("salaries", "amount", "number"), prop("salaries", "doubled", "formula", { formula: { expression: 'prop("amount") * 2' } })]);
    rules.set("amount", [{ level: "none" }]);
    const staff = [relation("staff", "pay", "salaries"), rollup("staff", "payDoubled", "pay", "doubled")];
    expect(await rollupsOverRestricted(staff as never)).toEqual(["payDoubled"]);
  });

  it("…and one over a rollup there over a restricted property a database further on", async () => {
    schemas.set("grants", [prop("grants", "secret", "text")]);
    schemas.set("projects", [relation("projects", "grant", "grants"), rollup("projects", "grantSecret", "grant", "secret")]);
    rules.set("secret", [{ level: "none" }]);
    const staff = [relation("staff", "project", "projects"), rollup("staff", "projectSecret", "project", "grantSecret")];
    expect(await rollupsOverRestricted(staff as never)).toEqual(["projectSecret"]);
  });

  it("keeps rollups over unrestricted properties, and finds nothing without rollups", async () => {
    schemas.set("salaries", [prop("salaries", "team", "text")]);
    expect(await rollupsOverRestricted([relation("staff", "pay", "salaries"), rollup("staff", "payTeam", "pay", "team")] as never)).toEqual([]);
    expect(await rollupsOverRestricted([prop("staff", "notes", "text")] as never)).toEqual([]);
  });

  it("counts rollups too many databases down as restricted", async () => {
    // a → b → c → d → e: past the limit, the rollup chain isn't followed and counts as restricted.
    const chain = ["b", "c", "d", "e"];
    chain.forEach((db, i) => {
      const next = chain[i + 1];
      schemas.set(db, next ? [relation(db, `${db}-rel`, next), rollup(db, `${db}-roll`, `${db}-rel`, `${next}-roll`)] : [prop(db, "e-roll", "text")]);
    });
    const a = [relation("a", "a-rel", "b"), rollup("a", "a-roll", "a-rel", "b-roll")];
    expect(await rollupsOverRestricted(a as never)).toEqual(["a-roll"]);
  });
});

describe("restrictedProperties", () => {
  it("closes over formulas and rollups reading restricted properties", () => {
    const props = [
      prop("staff", "codename", "text"),
      prop("staff", "upper", "formula", { formula: { expression: 'upper(prop("codename"))' } }),
      rollup("staff", "payAmount", "pay", "amount"),
      prop("staff", "summary", "formula", { formula: { expression: 'prop("payAmount")' } }),
      prop("staff", "notes", "text"),
    ];
    const restricted = restrictedProperties(props as never, ["codename"], new Set(["amount"]));
    expect([...restricted].sort()).toEqual(["codename", "payAmount", "summary", "upper"]);
  });
});

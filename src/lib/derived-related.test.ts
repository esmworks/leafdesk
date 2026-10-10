import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  compileFormulas,
  evaluateRow,
  formulaForEditing,
  formulaForStorage,
  mergeResults,
  relatedDatabase,
  type FormulaContext,
  type RelatedSchemas,
  type WithResults,
  withFormulaTypes,
} from "./derived";
import type { PropertyRule, PropertyViewer } from "./property-access";
import { makeAccess } from "./property-access-rows";
import { applyView } from "./properties";

type P = { id: string; name: string; type: PropertyType; options: PropertyOptions };
const prop = (id: string, name: string, type: PropertyType, options: PropertyOptions = {}): P => ({ id, name, type, options });
const formula = (id: string, name: string, expression: string) => prop(id, name, "formula", { formula: { expression } });
const rule = (propertyId: string, level: PropertyRule["level"], who: Partial<PropertyRule> = {}): PropertyRule => ({
  propertyId,
  userId: null,
  groupId: null,
  personPropertyId: null,
  level,
  ...who,
});

const NOW = new Date("2026-09-27T12:00:00Z");
const viewer: PropertyViewer = { userId: "u1", groupIds: [], databaseLevel: "edit" };
const PEOPLE = [
  { id: "u1", name: "Ada" },
  { id: "u2", name: "Bo" },
];

// The related database: tasks, some of whose properties the viewer may not see. Formula types
// filled in, as the server loads properties.
const tasks: P[] = withFormulaTypes([
  prop("hours", "Hours", "number"),
  prop("owner", "Owner", "person"),
  prop("secret", "Secret", "text"),
  prop("pay", "Pay", "number"),
  prop("notes", "Notes", "text"),
  prop("sub", "Subtasks", "relation", { relation: { databaseId: "db3" } }),
  formula("dbl", "Double", 'prop("hours") * 2'),
  formula("paid", "Paid", 'prop("pay") + 1'),
  formula("deep", "Deep", 'map(prop("sub"), prop(current, "x"))'),
]);
const taskRules = new Map<string, PropertyRule[]>([
  // Nobody but full access knows of it.
  ["secret", [rule("secret", "none")]],
  // Known, but its values are hidden.
  ["pay", [rule("pay", "view_property")]],
  // Seen in the rows the viewer owns only.
  ["notes", [rule("notes", "view_property"), rule("notes", "view", { personPropertyId: "owner" })]],
]);
const taskRows = [
  { id: "t1", title: "Write", properties: { hours: 2, owner: ["u1"], secret: "s1", pay: 100, notes: "mine" } },
  { id: "t2", title: "Test", properties: { hours: 3, owner: ["u2"], secret: "s2", pay: 50, notes: "theirs" } },
  // A row the viewer can't open: not loaded, and its title isn't known.
  { id: "t3", title: "Hidden", properties: { hours: 40, owner: ["u2"], secret: "s3", pay: 1, notes: "x" } },
];

/** The tasks as the server loads them for this viewer (see server/derived loadRelated). */
function loadTasks(rules = taskRules, who = viewer) {
  const access = makeAccess(rules, who, tasks);
  const visibleRows = taskRows.filter((r) => r.id !== "t3");
  const stripped = access.strip(visibleRows);
  const compiled = compileFormulas(tasks);
  const ctx: FormulaContext = { now: NOW, people: PEOPLE };
  const computed = stripped.map((row) => mergeResults(row, evaluateRow(tasks, compiled, row, ctx), compiled));
  return relatedDatabase(tasks, access.finish(computed), (props) => access.visible(props), ctx);
}

const projects: P[] = [
  prop("rel", "Tasks", "relation", { relation: { databaseId: "db2" } }),
  formula("titles", "Titles", 'prop("rel")'),
  formula("hoursSum", "Hours", 'sum(map(prop("rel"), prop(current, "hours")))'),
  formula("styled", "Styled", 'style(prop("hoursSum"), "b", "red")'),
  formula("dblSum", "Doubled", 'sum(map(prop("rel"), prop(current, "dbl")))'),
  formula("owners", "Owners", 'map(prop("rel"), prop(current, "owner"))'),
  formula("paySum", "Pay", 'sum(map(prop("rel"), prop(current, "pay")))'),
  formula("paidSum", "Paid", 'sum(map(prop("rel"), prop(current, "paid")))'),
  formula("chain", "Chain", 'prop("paySum") + 1'),
  formula("secrets", "Secrets", 'map(prop("rel"), prop(current, "secret"))'),
  formula("secretCount", "Secret count", 'length(filter(prop("rel"), prop(current, "secret") == "s1"))'),
  formula("notes", "Notes", 'map(prop("rel"), prop(current, "notes"))'),
  formula("deepRead", "Deep", 'map(prop("rel"), prop(current, "deep"))'),
];
const related: RelatedSchemas = (id) => (id === "db2" ? tasks : undefined);
type Row = { id: string; title: string; properties: Record<string, unknown>; createdAt: Date; updatedAt: Date } & WithResults;
const projectRows: Row[] = [
  { id: "a", title: "A", properties: { rel: ["t1", "t3"] }, createdAt: NOW, updatedAt: NOW },
  { id: "b", title: "B", properties: { rel: ["t1", "t2"] }, createdAt: NOW, updatedAt: NOW },
];
const ctx = (db = loadTasks()): FormulaContext => ({
  now: NOW,
  people: PEOPLE,
  // The titles of linked rows the viewer may see (t3 is left out).
  relations: { rel: { rows: [{ id: "t1", title: "Write" }, { id: "t2", title: "Test" }] } },
  related: new Map([["db2", db]]),
});

function evaluate(context = ctx()) {
  const compiled = compileFormulas(projects, related);
  return projectRows.map((row) => mergeResults(row, evaluateRow(projects, compiled, row, context), compiled));
}

describe("formulas over related rows", () => {
  it("reads what the viewer may see, leaving out rows they can't open", () => {
    const [a, b] = evaluate();
    expect(a.properties.titles).toBe("Write");
    expect(b.properties.titles).toBe("Write, Test");
    // t3's 40 hours don't count: the viewer can't open it.
    expect(a.properties.hoursSum).toBe(2);
    expect(b.properties.hoursSum).toBe(5);
    expect(b.properties.dblSum).toBe(10);
    expect(b.properties.owners).toBe("Ada, Bo");
  });

  it("shows nothing for a formula over a related value the viewer may not see", () => {
    const [a, b] = evaluate();
    for (const row of [a, b]) {
      // Values hidden in every row, a formula over one, and a property they can't know of.
      for (const id of ["paySum", "paidSum", "secrets", "secretCount"]) {
        expect(row.properties, id).not.toHaveProperty(id);
        expect(row.hidden, id).toContain(id);
      }
      // A formula over one of those is hidden too, not an error that tells something.
      expect(row.properties).not.toHaveProperty("chain");
      expect(row.hidden).toContain("chain");
    }
  });

  it("follows per-row rules of the related database", () => {
    const [a, b] = evaluate();
    // a links t1, which the viewer owns; b also links t2, whose notes they may not see.
    expect(a.properties.notes).toBe("mine");
    expect(b.properties).not.toHaveProperty("notes");
    expect(b.hidden).toContain("notes");
    expect(a.hidden ?? []).not.toContain("notes");
  });

  it("shows everything to a viewer with full access", () => {
    const full = { ...viewer, databaseLevel: "full" as const };
    const [, b] = evaluate(ctx(loadTasks(taskRules, full)));
    expect(b.properties.paySum).toBe(150);
    expect(b.properties.paidSum).toBe(152);
    expect(b.properties.chain).toBe(151);
    expect(b.properties.secrets).toBe("s1, s2");
    expect(b.properties.secretCount).toBe(1);
    expect(b.properties.notes).toBe("mine, theirs");
    expect(b.hidden ?? []).toEqual([]);
  });

  it("hides everything related without a way to read related rows", () => {
    // A database of related rows the viewer can't open: nothing of it loads.
    const [, b] = evaluate({ ...ctx(), related: new Map() });
    expect(b.properties.titles).toBe("Write, Test");
    expect(b.properties).not.toHaveProperty("hoursSum");
    expect(b.hidden).toEqual(expect.arrayContaining(["hoursSum", "styled", "owners"]));
  });

  it("reads related rows one hop deep", () => {
    const compiled = compileFormulas(projects, related);
    expect(compiled.get("deepRead")!.error?.code).toBe("relatedDepth");
    const [, b] = evaluate();
    expect(b.properties.deepRead).toEqual({ error: expect.objectContaining({ code: "relatedDepth" }) });
  });

  it("keeps styles apart from the stored value", () => {
    const [a, b] = evaluate();
    expect(b.properties.styled).toBe(5);
    expect(b.styles?.styled).toEqual({ styles: ["b", "red"] });
    // Sorting and filtering use the value, not how it shows.
    const sorted = applyView([b, a], { sorts: [{ propertyId: "styled", direction: "asc" }] }, projects);
    expect(sorted.map((r) => r.title)).toEqual(["A", "B"]);
    const filtered = applyView([a, b], { filters: [{ propertyId: "styled", op: "gt", value: 3 }] }, projects);
    expect(filtered.map((r) => r.title)).toEqual(["B"]);
  });

  it("leaves formulas over related rows to the server in the browser", () => {
    const [, server] = evaluate();
    const compiled = compileFormulas(projects, related);
    const { related: _, ...browser } = ctx();
    const changed: Row = { ...server, properties: { ...server.properties, rel: ["t1"] } };
    const again = mergeResults(changed, evaluateRow(projects, compiled, changed, browser), compiled);
    // Titles are worked out again; related reads keep the server's values, styles and hidden list.
    expect(again.properties.titles).toBe("Write");
    expect(again.properties.hoursSum).toBe(5);
    expect(again.styles?.styled).toEqual({ styles: ["b", "red"] });
    expect(again.hidden).toContain("paySum");
  });
});

describe("storing formulas over related rows", () => {
  it("stores related properties by id and edits them by name", () => {
    const own = projects.filter((p) => p.type !== "formula");
    const text = 'sum(map(prop("Tasks"), prop(current, "Hours"))) + prop(first(prop("Tasks")), "Pay")';
    const stored = formulaForStorage(text, own, ["Name"], related);
    expect(stored).toBe('sum(map(prop("rel"), prop(current, "hours"))) + prop(first(prop("rel")), "pay")');
    expect(formulaForEditing(stored, own, "Name", tasks)).toBe(text);
    // Without related schemas (a database the viewer can't open) names stay, and checking reports them.
    expect(formulaForStorage(text, own, ["Name"])).toBe('sum(map(prop("rel"), prop(current, "Hours"))) + prop(first(prop("rel")), "Pay")');
  });

  it("reports a related property that doesn't exist", () => {
    const self = formula("f", "F", formulaForStorage('map(prop("Tasks"), prop(current, "Nope"))', projects, [], related));
    expect(compileFormulas([projects[0], self], related).get("f")!.error?.code).toBe("unknownProperty");
  });
});

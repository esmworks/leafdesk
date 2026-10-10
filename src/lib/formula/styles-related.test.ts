import { describe, expect, it } from "vitest";
import { SELECT_COLORS } from "@/lib/properties";
import {
  checkFormula,
  HiddenValue,
  MAX_RELATED_ROWS,
  parseFormula,
  relatedReads,
  runFormula,
  STYLE_COLORS,
  type Field,
  type FormulaType,
  type RowRef,
  type Value,
} from ".";

const NOW = new Date("2026-09-27T10:30:00Z");

type Fields = Record<string, { type: FormulaType; value: Value; database?: string }>;
type Related = Record<string, Record<string, { type: FormulaType; relatedReads?: boolean }>>;
/** Values of related rows by row id, then property name. A missing value reads as hidden. */
type RelatedValues = Record<string, Record<string, Value>>;

const row = (rowId: string, title: string, extra: Partial<RowRef> = {}): RowRef => ({ rowId, databaseId: "tasks", title, ...extra });

const fields: Fields = {
  Name: { type: "text", value: "Launch" },
  Price: { type: "number", value: 12.5 },
  Done: { type: "checkbox", value: true },
  Tags: { type: "list", value: ["red", "blue"] },
  Tasks: { type: "rows", database: "tasks", value: [row("t1", "Draft"), row("t2", "Review"), row("t3", "Ship")] },
  NoTasks: { type: "rows", database: "tasks", value: [] },
};

const related: Related = {
  tasks: {
    Hours: { type: "number" },
    Owner: { type: "text" },
    Finished: { type: "checkbox" },
    Secret: { type: "text" },
    Labels: { type: "list" },
    Deep: { type: "text", relatedReads: true },
  },
};

const values: RelatedValues = {
  t1: { Hours: 2, Owner: "Ada", Finished: true, Labels: ["a"] },
  t2: { Hours: 3, Owner: "Bo", Finished: false, Labels: [] },
  t3: { Hours: null, Owner: "Ada", Finished: true, Labels: ["b", "c"] },
};

function run(expression: string, own: Fields = fields, relatedValues: RelatedValues | null = values) {
  const parsed = parseFormula(expression);
  const resolve = (key: string): Field | undefined =>
    own[key] ? { name: key, type: own[key].type, database: own[key].database } : undefined;
  const resolveRelated = (database: string, key: string): Field | undefined => {
    const field = related[database]?.[key];
    return field ? { name: key, ...field } : undefined;
  };
  const { type, error, notes } = checkFormula(parsed, resolve, resolveRelated);
  if (error) return { error: error.code, type };
  try {
    const result = runFormula(parsed.ast, {
      value: (key) => own[key].value,
      now: NOW,
      notes,
      related: relatedValues
        ? (r, key) => {
            const v = relatedValues[r.rowId];
            if (!v || !(key in v)) throw new HiddenValue();
            return v[key];
          }
        : undefined,
    });
    return { value: result.stored, style: result.style, type };
  } catch (e) {
    if (e instanceof HiddenValue) return { hidden: true, type };
    return { error: (e as { error: { code: string } }).error.code, type };
  }
}

const value = (expression: string, own?: Fields, rel?: RelatedValues | null) => run(expression, own, rel).value;
const error = (expression: string, own?: Fields) => run(expression, own).error;
const style = (expression: string) => run(expression).style;

describe("styled results", () => {
  it("offers the select option colors", () => {
    expect([...STYLE_COLORS].sort()).toEqual([...SELECT_COLORS].sort());
  });

  it("keeps the value and its type, and styles it", () => {
    expect(run('style(prop("Price"), "b", "red")')).toMatchObject({ value: 12.5, type: "number", style: { styles: ["b", "red"] } });
    expect(run('style(prop("Done"), "green_background")')).toMatchObject({ value: true, type: "checkbox" });
    expect(run('style("x", "B", "I", "U", "S", "C")').style).toEqual({ styles: ["b", "i", "u", "s", "c"] });
  });

  it("lets a later color replace an earlier one of the same kind", () => {
    expect(style('style(style("x", "red", "blue_background"), "green")')).toEqual({ styles: ["blue_background", "green"] });
    expect(style('style("x", "b", "b")')).toEqual({ styles: ["b"] });
  });

  it("checks style names", () => {
    expect(error('style("x", "rainbow")')).toBe("invalidStyle");
    expect(error('style("x", "red_text")')).toBe("invalidStyle");
    expect(error("style(\"x\", \"b\" + \"\")")).toBe(undefined);
    expect(run('style("x", if(true, "teal", "b"))').error).toBe("invalidStyle");
  });

  it("styles each part of joined text", () => {
    expect(run('style("Due: ", "b") + style("today", "red")')).toMatchObject({
      value: "Due: today",
      style: { parts: [{ text: "Due: ", styles: ["b"] }, { text: "today", styles: ["red"] }] },
    });
    expect(style('concat(style("a", "i"), "b", 1)')).toEqual({ parts: [{ text: "a", styles: ["i"] }, { text: "b1", styles: [] }] });
  });

  it("passes styles through if and ifs, and drops them in other functions", () => {
    expect(style('if(prop("Done"), style("yes", "green"), "no")')).toEqual({ styles: ["green"] });
    expect(style('ifs(false, "a", style("b", "u"))')).toEqual({ styles: ["u"] });
    expect(run('upper(style("ok", "b"))')).toMatchObject({ value: "OK", style: null });
    expect(run('style(1, "b") + 2')).toMatchObject({ value: 3, style: null });
    expect(run('length(style("abc", "red"))')).toMatchObject({ value: 3, style: null });
  });

  it("removes styles with unstyle", () => {
    expect(run('unstyle(style("x", "b"))')).toMatchObject({ value: "x", style: null });
    expect(run('unstyle(style("a", "b") + "c")')).toMatchObject({ value: "ac", style: null });
  });

  it("has no style for an empty result", () => {
    expect(run('style("", "b")')).toMatchObject({ value: null, style: null });
  });
});

describe("related rows", () => {
  it("still reads a relation alone as its titles", () => {
    expect(value('prop("Tasks")')).toBe("Draft, Review, Ship");
    expect(value('length(prop("Tasks"))')).toBe(3);
    expect(value('contains(prop("Tasks"), "Ship")')).toBe(true);
    expect(value('join(prop("Tasks"), " / ")')).toBe("Draft / Review / Ship");
    expect(value('prop("Tasks") == prop("Tasks")')).toBe(true);
    expect(value('prop("NoTasks")')).toBeNull();
  });

  it("reads properties of related rows with map and current", () => {
    expect(run('map(prop("Tasks"), prop(current, "Owner"))')).toMatchObject({ value: "Ada, Bo, Ada", type: "text" });
    expect(value('sum(map(prop("Tasks"), prop(current, "Hours")))')).toBe(5);
    expect(value('average(map(prop("Tasks"), prop(current, "Hours")))')).toBe(2.5);
    expect(value('max(map(prop("Tasks"), prop(current, "Hours")))')).toBe(3);
    expect(value('sum(map(prop("NoTasks"), prop(current, "Hours")))')).toBe(0);
  });

  it("filters, finds and tests rows", () => {
    expect(value('filter(prop("Tasks"), prop(current, "Finished"))')).toBe("Draft, Ship");
    expect(value('length(filter(prop("Tasks"), prop(current, "Owner") == "Ada"))')).toBe(2);
    expect(value('find(prop("Tasks"), prop(current, "Owner") == "Bo")')).toBe("Review");
    expect(value('prop(find(prop("Tasks"), prop(current, "Owner") == "Bo"), "Hours")')).toBe(3);
    expect(value('some(prop("Tasks"), not prop(current, "Finished"))')).toBe(true);
    expect(value('every(prop("Tasks"), prop(current, "Finished"))')).toBe(false);
    expect(value('every(prop("NoTasks"), prop(current, "Finished"))')).toBe(true);
  });

  it("picks rows by position", () => {
    expect(value('prop(first(prop("Tasks")), "Owner")')).toBe("Ada");
    expect(value('prop(last(prop("Tasks")), "Owner")')).toBe("Ada");
    expect(value('prop(at(prop("Tasks"), 1), "Owner")')).toBe("Bo");
    expect(value('at(prop("Tasks"), -1)')).toBe("Ship");
    expect(value('at(prop("Tasks"), 7)')).toBeNull();
  });

  it("reads an empty value for no row", () => {
    expect(value('prop(first(prop("NoTasks")), "Owner")')).toBeNull();
    expect(value('prop(first(prop("NoTasks")), "Hours") + 1')).toBe(1);
  });

  it("adds the items of a list for each row: lists don't nest", () => {
    expect(run('map(prop("Tasks"), prop(current, "Labels"))')).toMatchObject({ value: "a, b, c", type: "text" });
    expect(value('length(map(prop("Tasks"), prop(current, "Labels")))')).toBe(3);
    expect(run('map(prop("Tasks"), map(prop("Tasks"), 1))')).toMatchObject({ value: "1, 1, 1, 1, 1, 1, 1, 1, 1", type: "text" });
    expect(value('sum(map(prop("Tasks"), map(prop("Tasks"), 1)))')).toBe(9);
  });

  it("works on plain lists too", () => {
    expect(value('map(prop("Tags"), upper(current))')).toBe("RED, BLUE");
    expect(value('filter(prop("Tags"), current != "red")')).toBe("blue");
    expect(value('sum(map(prop("Tags"), length(current)))')).toBe(7);
  });

  it("checks how rows are used", () => {
    expect(error('prop("Name", "Owner")')).toBe("argumentType");
    expect(error('prop(first(prop("Tasks")), "Nope")')).toBe("unknownProperty");
    expect(error('prop(first(prop("Tasks")), "Deep")')).toBe("relatedDepth");
    expect(error("current")).toBe("currentOutside");
    expect(error('if(true, first(prop("Tasks")), "x")')).toBe("branchTypes");
  });

  it("lists the related reads of a formula", () => {
    const reads = relatedReads(parseFormula('map(prop("Tasks"), prop(current, "Owner")) + prop("Name")').ast!);
    expect(reads.map((n) => n.key)).toEqual(["Owner"]);
  });

  it("hides the result when a related value is hidden", () => {
    // Secret is a property of the related database the reader may not see.
    expect(run('map(prop("Tasks"), prop(current, "Secret"))').hidden).toBe(true);
    // A filter on a hidden value must not tell which rows match either.
    expect(run('length(filter(prop("Tasks"), prop(current, "Secret") == "x"))').hidden).toBe(true);
    expect(run('if(some(prop("Tasks"), prop(current, "Secret") == "x"), 1, 1)').hidden).toBe(true);
    // An error from a hidden value isn't shown either: the formula is hidden.
    expect(run('toNumber(prop(first(prop("Tasks")), "Secret"))').hidden).toBe(true);
    // Without a way to read related rows (no viewer), every related read is hidden.
    expect(run('prop(first(prop("Tasks")), "Owner")', fields, null).hidden).toBe(true);
    // Titles need no related read.
    expect(run('prop("Tasks")', fields, null)).toMatchObject({ value: "Draft, Review, Ship" });
  });

  it("refuses to read rows past the limit", () => {
    const many = Array.from({ length: MAX_RELATED_ROWS + 1 }, (_, i) =>
      row(`r${i}`, `Row ${i}`, i >= MAX_RELATED_ROWS ? { beyond: true } : {}),
    );
    const own: Fields = { ...fields, Tasks: { type: "rows", database: "tasks", value: many } };
    const rel: RelatedValues = Object.fromEntries(many.map((r) => [r.rowId, { Hours: 1 }]));
    expect(run('sum(map(prop("Tasks"), prop(current, "Hours")))', own, rel).error).toBe("relatedLimit");
    expect(run('sum(map(filter(prop("Tasks"), false), prop(current, "Hours")))', own, rel).value).toBe(0);
    expect(run('length(prop("Tasks"))', own, rel).value).toBe(MAX_RELATED_ROWS + 1);
  });

  it("keeps styles of related values only through style()", () => {
    expect(style('style(prop(first(prop("Tasks")), "Owner"), "b")')).toEqual({ styles: ["b"] });
    expect(style('map(prop("Tasks"), style(prop(current, "Owner"), "b"))')).toBeNull();
  });
});

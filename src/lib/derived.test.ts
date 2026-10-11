import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  compileFormulas,
  evaluateFormulas,
  formulaForEditing,
  formulaForStorage,
  isErrorValue,
  valueType,
  withFormulas,
  withFormulaTypes,
} from "./derived";
import { aggregate } from "./aggregate";
import { applyView, displayValue, filterOperators, normalizeValue, PropertyValueError } from "./properties";

type P = { id: string; name: string; type: PropertyType; options: PropertyOptions };
const prop = (id: string, name: string, type: PropertyType, options: PropertyOptions = {}): P => ({ id, name, type, options });
const formula = (id: string, name: string, expression: string) => prop(id, name, "formula", { formula: { expression } });

const NOW = new Date("2026-09-27T12:00:00Z");
const status = prop("st", "Status", "select", {
  options: [
    { id: "o1", name: "Open", color: "gray" },
    { id: "o2", name: "Done", color: "green" },
  ],
});
const base: P[] = [
  prop("price", "Price", "number"),
  prop("qty", "Quantity", "number"),
  prop("due", "Due", "date"),
  prop("done", "Done", "checkbox"),
  prop("tags", "Tags", "multi_select", { options: [{ id: "t1", name: "red", color: "red" }] }),
  prop("who", "Owner", "person"),
  prop("rel", "Tasks", "relation", { relation: { databaseId: "db2" } }),
  prop("list", "Steps", "checklist"),
  status,
];

function row(properties: Record<string, unknown>, title = "Row") {
  return { id: "r1", title, properties, createdAt: NOW, updatedAt: NOW };
}

function values(props: P[], properties: Record<string, unknown>, title = "Row") {
  const [out] = withFormulas(props, [row(properties, title)], {
    now: NOW,
    people: [{ id: "u1", name: "Ada" }],
    relations: { rel: { rows: [{ id: "x1", title: "Write spec" }] } },
  });
  return out.properties;
}

describe("formula properties", () => {
  it("read every kind of property", () => {
    const props = [
      ...base,
      formula("f1", "Total", 'prop("price") * prop("qty")'),
      formula("f2", "Label", 'prop("title") + " / " + prop("Status") + " / " + join(prop("Tags"), "+")'),
      formula("f3", "People", 'join(prop("Owner"), ";") + "|" + join(prop("Tasks"), ";")'),
      formula("f4", "Soon", 'dateBetween(prop("Due"), now(), "days") < 7 and not prop("Done")'),
      formula("f5", "Progress", 'round(prop("Steps") * 100)'),
    ];
    const out = values(props, {
      price: 2.5,
      qty: 4,
      due: "2026-10-01",
      done: false,
      tags: ["t1", "gone"],
      who: ["u1", "u-unknown"],
      rel: ["x1", "hidden"],
      list: [
        { id: "a", text: "a", checked: true },
        { id: "b", text: "b", checked: false },
      ],
      st: "o2",
    });
    expect(out).toMatchObject({ f1: 10, f2: "Row / Done / red", f3: "Ada|Write spec", f4: true, f5: 50 });
  });

  it("let formulas use other formulas, in any order", () => {
    const props = [formula("a", "A", 'prop("B") * 2'), formula("b", "B", 'prop("price") + 1'), ...base];
    expect(values(props, { price: 1 })).toMatchObject({ a: 4, b: 2 });
    expect(compileFormulas(props).get("a")!.type).toBe("number");
  });

  it("report cycles and references to broken formulas", () => {
    const props = [
      formula("a", "A", 'prop("B") + 1'),
      formula("b", "B", 'prop("A") + 1'),
      formula("c", "C", 'prop("A") * 2'),
      formula("d", "D", 'prop("D")'),
    ];
    const compiled = compileFormulas(props);
    expect(compiled.get("a")!.error).toMatchObject({ code: "cycle", params: { name: "A" } });
    expect(compiled.get("b")!.error?.code).toBe("cycle");
    expect(compiled.get("c")!.error).toMatchObject({ code: "referenceError", params: { name: "A" } });
    expect(compiled.get("d")!.error?.code).toBe("cycle");
    const out = values(props, {});
    expect(isErrorValue(out.a) && out.a.error.code).toBe("cycle");
    expect(isErrorValue(out.c) && out.c.error.code).toBe("referenceError");
  });

  it("pass a row's runtime error on to the formulas that use it", () => {
    const props = [...base, formula("a", "Ratio", 'prop("price") / prop("qty")'), formula("b", "Pct", 'prop("Ratio") * 100')];
    const ok = values(props, { price: 1, qty: 4 });
    expect(ok).toMatchObject({ a: 0.25, b: 25 });
    const broken = values(props, { price: 1, qty: 0 });
    expect(broken.a).toMatchObject({ error: { code: "divisionByZero" } });
    expect(broken.b).toMatchObject({ error: { code: "referenceError", params: { name: "Ratio" } } });
  });

  it("fail on the row instead of throwing when evaluation breaks some other way", () => {
    const props = [...base, formula("a", "When", "now()"), formula("b", "Total", 'prop("price") * 2')];
    const broken = { now: {} as Date };
    const [out] = withFormulas(props, [row({ price: 2 })], broken);
    expect(out.properties.a).toMatchObject({ error: { code: "evaluationFailed" } });
    expect(out.properties.b).toBe(4);
    const exhausted = {
      now: {
        getTime: () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
      } as unknown as Date,
    };
    expect(withFormulas(props, [row({ price: 2 })], exhausted)[0].properties.a).toMatchObject({ error: { code: "tooExpensive" } });
  });

  it("share a read's steps between its rows, past what each formula takes on its own", () => {
    // replaceAll() takes a step per part: about 2,000 for each row.
    const props = [...base, formula("a", "Long", 'length(replaceAll(prop("title"), "a", "b"))'), formula("b", "Total", 'prop("price") * 2')];
    const rows = Array.from({ length: 10 }, (_, i) => row({ price: i }, "a".repeat(2000)));
    const out = withFormulas(props, rows, { now: NOW, steps: { left: 3000 } }).map((r) => r.properties);
    expect(out.slice(0, 2).map((p) => p.a)).toEqual([2000, 2000]);
    expect(out.at(-1)!.a).toMatchObject({ error: { code: "tooExpensive" } });
    // A formula that takes little keeps working once the shared steps are gone.
    expect(out.map((p) => p.b)).toEqual(rows.map((_, i) => i * 2));
  });

  it("keep working after a property is renamed, and break when it is deleted", () => {
    const stored = formulaForStorage('prop("Price") * 2 + prop("Name")', base, ["Name"]);
    expect(stored).toBe('prop("price") * 2 + prop("title")');
    const renamed = base.map((p) => (p.id === "price" ? { ...p, name: "Unit price" } : p));
    expect(formulaForEditing(stored, renamed, "Name")).toBe('prop("Unit price") * 2 + prop("Name")');
    expect(values([...renamed, formula("f", "F", 'prop("price") * 2')], { price: 3 }).f).toBe(6);
    const deleted = values([...base.filter((p) => p.id !== "price"), formula("f", "F", stored)], {});
    expect(deleted.f).toMatchObject({ error: { code: "unknownProperty", params: { name: "price" } } });
  });

  it("show the title as prop(\"title\") when a property is called like the Name column", () => {
    const props = [prop("n", "Name", "text")];
    expect(formulaForEditing('prop("title") + prop("n")', props, "Name")).toBe('prop("title") + prop("Name")');
    expect(formulaForStorage('prop("title") + prop("Name")', props, ["Name"])).toBe('prop("title") + prop("n")');
  });

  it("fill in result types", () => {
    const props = withFormulaTypes([...base, formula("a", "A", 'prop("Due")'), formula("b", "B", "1 > 2"), formula("c", "C", "nope(")]);
    expect(props.map((p) => p.options.formula?.type).filter(Boolean)).toEqual(["date", "checkbox", "text"]);
    expect(valueType(props.find((p) => p.id === "a")!)).toBe("date");
  });

  it("are read-only", () => {
    expect(() => normalizeValue(formula("f", "Total", "1"), 5)).toThrow(PropertyValueError);
  });

  it("evaluate once per formula even when several formulas use it", () => {
    const props = [...base, formula("a", "A", "now()"), formula("b", "B", 'prop("A")'), formula("c", "C", 'prop("A")')];
    const compiled = compileFormulas(props);
    const out = evaluateFormulas(props, compiled, row({}), { now: NOW });
    expect(out.b).toBe(out.c);
  });
});

describe("views on formula values", () => {
  const props = withFormulaTypes([
    ...base,
    formula("total", "Total", 'prop("price") * prop("qty")'),
    formula("when", "When", 'dateAdd(prop("Due"), 1, "days")'),
    formula("big", "Big", 'prop("Total") > 10'),
    formula("ratio", "Ratio", 'prop("price") / prop("qty")'),
  ]);
  const rows = withFormulas(
    props,
    [
      row({ price: 2, qty: 3, due: "2026-09-27" }, "a"),
      row({ price: 5, qty: 4, due: "2026-10-05" }, "b"),
      row({ price: 1, qty: 0 }, "c"),
    ],
    { now: NOW },
  );
  const titles = (list: { title: string }[]) => list.map((r) => r.title);

  it("filter and sort by the result type", () => {
    expect(titles(applyView(rows, { filters: [{ propertyId: "total", op: "gt", value: 5 }] }, props))).toEqual(["a", "b"]);
    expect(titles(applyView(rows, { filters: [{ propertyId: "when", op: "equals", value: "2026-09-28" }] }, props))).toEqual(["a"]);
    expect(titles(applyView(rows, { filters: [{ propertyId: "big", op: "is_not_empty" }] }, props))).toEqual(["b"]);
    expect(titles(applyView(rows, { sorts: [{ propertyId: "total", direction: "desc" }] }, props))).toEqual(["b", "a", "c"]);
  });

  it("treat errors as empty", () => {
    expect(titles(applyView(rows, { filters: [{ propertyId: "ratio", op: "is_empty" }] }, props))).toEqual(["c"]);
    expect(titles(applyView(rows, { sorts: [{ propertyId: "ratio", direction: "asc" }] }, props))).toEqual(["a", "b", "c"]);
    expect(displayValue(props.find((p) => p.id === "ratio")!, rows[2].properties.ratio)).toEqual({ error: "Division by zero" });
  });

  it("offer the operators of the result type", () => {
    const total = props.find((p) => p.id === "total")!;
    expect(filterOperators(valueType(total)).map((o) => o.op)).toContain("gt");
    expect(filterOperators(valueType(props.find((p) => p.id === "big")!)).map((o) => o.label)).toEqual(["isChecked", "isUnchecked"]);
  });

  it("calculate like values of the result type", () => {
    const total = props.find((p) => p.id === "total")!;
    expect(aggregate(rows, "total", "sum", { type: valueType(total) })).toEqual({ format: "number", value: 26 });
    expect(aggregate(rows, "ratio", "count_not_empty", { type: valueType(total) })).toEqual({ format: "number", value: 2 });
  });
});

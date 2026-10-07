import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType, SelectOption, ViewConfig } from "@/db/schema/app";
import { lostValues, planConversion, retypeViewConfig, type ConversionContext } from "./convert-property";

let counter = 0;
const ctx = (extra: Partial<ConversionContext> = {}): ConversionContext => ({
  people: [
    { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    { id: "u2", name: "Alan Turing", email: "alan@example.test" },
  ],
  yes: "Evet",
  newId: () => `n${++counter}`,
  ...extra,
});
const side = (type: PropertyType, options: PropertyOptions = {}) => ({ type, options });
const convertAll = (from: ReturnType<typeof side>, to: PropertyType, values: unknown[], extra?: Partial<ConversionContext>) => {
  counter = 0;
  const plan = planConversion(from, { type: to }, values, ctx(extra));
  return { ...plan, out: values.map(plan.convert), lost: lostValues(values, plan) };
};

const options: SelectOption[] = [
  { id: "a", name: "Open", color: "blue" },
  { id: "b", name: "Closed", color: "red" },
];

describe("planConversion", () => {
  it("makes select options from distinct text values and maps rows to them", () => {
    const { options: made, out, lost } = convertAll(side("text"), "select", ["Red", "blue", "red", null, "Blue"]);
    expect(made?.map((o) => o.name)).toEqual(["Red", "blue"]);
    expect(out).toEqual(["n1", "n2", "n1", null, "n2"]);
    expect(lost).toBe(0);
  });

  it("splits text at commas for a multi-select", () => {
    const { options: made, out } = convertAll(side("text"), "multi_select", ["a, b", "b; c"]);
    expect(made?.map((o) => o.name)).toEqual(["a", "b", "c"]);
    expect(out).toEqual([["n1", "n2"], ["n2", "n3"]]);
  });

  it("keeps option ids between select, multi-select and status", () => {
    const multi = convertAll(side("select", { options }), "multi_select", ["a", "b", null]);
    expect(multi.options).toEqual(options);
    expect(multi.out).toEqual([["a"], ["b"], null]);
    const single = convertAll(side("multi_select", { options }), "select", [["b", "a"], ["gone"]]);
    expect(single.out).toEqual(["b", null]);
    const status = convertAll(side("select", { options }), "status", ["a"]);
    expect(status.options?.every((o) => o.group === "todo")).toBe(true);
    expect(status.out).toEqual(["a"]);
    const back = convertAll(side("status", { options: status.options }), "select", ["a"]);
    expect(back.options?.some((o) => "group" in o)).toBe(false);
  });

  it("gives a status property its default options when the values make none", () => {
    const { options: made } = convertAll(side("number"), "status", [null]);
    expect(made?.map((o) => o.group)).toEqual(["todo", "in_progress", "done"]);
  });

  it("reads numbers as people write them and counts what doesn't parse", () => {
    const { out, lost } = convertAll(side("text"), "number", ["1.234,5", "12", "twelve", ""]);
    expect(out).toEqual([1234.5, 12, null, null]);
    expect(lost).toBe(1);
  });

  it("reads a column's dates in the one format they share", () => {
    const { out } = convertAll(side("text"), "date", ["03/04/2026", "25/04/2026", "nope"]);
    expect(out).toEqual(["2026-04-03", "2026-04-25", null]);
  });

  it("turns timestamps into days and dates into text", () => {
    expect(convertAll(side("created_time"), "date", ["2026-10-07T09:30:00.000Z"]).out).toEqual(["2026-10-07"]);
    expect(convertAll(side("date"), "text", ["2026-10-07"]).out).toEqual(["2026-10-07"]);
  });

  it("writes a ticked box as the viewer's yes, which reads back as ticked", () => {
    const text = convertAll(side("checkbox"), "text", [true, false]);
    expect(text.out).toEqual(["Evet", null]);
    expect(text.lost).toBe(0);
    const box = convertAll(side("text"), "checkbox", ["Evet", "no", "maybe"]);
    expect(box.out).toEqual([true, false, null]);
    expect(box.lost).toBe(1);
  });

  it("names people as text and finds them by name or email", () => {
    expect(convertAll(side("person"), "text", [["u1", "u2"], ["gone"]]).out).toEqual(["Ada Lovelace, Alan Turing", null]);
    expect(convertAll(side("text"), "person", ["ada lovelace, alan@example.test", "Nobody"]).out).toEqual([["u1", "u2"], null]);
    expect(convertAll(side("created_by"), "person", [["u2"]]).out).toEqual([["u2"]]);
    expect(convertAll(side("person"), "email", [["u2"]]).out).toEqual(["alan@example.test"]);
  });

  it("titles related rows as text and links rows by title", () => {
    const sourceTitles = new Map([["r1", "Alpha"], ["r2", "Beta"]]);
    expect(convertAll(side("relation"), "text", [["r1", "r2", "hidden"]], { sourceTitles }).out).toEqual(["Alpha, Beta"]);
    const targetRows = [
      { id: "t1", title: "Alpha" },
      { id: "t2", title: "Twin" },
      { id: "t3", title: "twin" },
    ];
    expect(convertAll(side("text"), "relation", ["alpha, Twin, Nope"], { targetRows }).out).toEqual([["t1"]]);
  });

  it("checks links, emails and phone numbers", () => {
    expect(convertAll(side("text"), "url", ["https://a.example", "example.com/x", "not a link"]).out).toEqual([
      "https://a.example",
      "https://example.com/x",
      null,
    ]);
    expect(convertAll(side("email"), "url", ["a@example.test"]).out).toEqual(["mailto:a@example.test"]);
    expect(convertAll(side("url"), "email", ["mailto:a@example.test"]).out).toEqual(["a@example.test"]);
    expect(convertAll(side("text"), "phone", ["+90 555 123 45 67", "call me"]).out).toEqual(["+90 555 123 45 67", null]);
  });

  it("round-trips checklists through text", () => {
    const items = [
      { id: "i1", text: "Done", checked: true },
      { id: "i2", text: "Open", checked: false },
    ];
    const text = convertAll(side("checklist"), "text", [items]).out[0];
    expect(text).toBe("[x] Done\n[ ] Open");
    const back = convertAll(side("text"), "checklist", [text]).out[0] as { text: string; checked: boolean }[];
    expect(back.map(({ text, checked }) => ({ text, checked }))).toEqual([
      { text: "Done", checked: true },
      { text: "Open", checked: false },
    ]);
    expect(convertAll(side("multi_select", { options }), "checklist", [["a", "b"]]).out[0]).toMatchObject([
      { text: "Open", checked: false },
      { text: "Closed", checked: false },
    ]);
  });

  it("freezes what a formula works out", () => {
    expect(convertAll(side("formula"), "number", [42, { error: { message: "x" } }]).out).toEqual([42, null]);
    expect(convertAll(side("formula"), "text", [true, "hi"]).out).toEqual(["Evet", "hi"]);
  });

  it("keeps files only as files, and nothing for types Leafdesk works out", () => {
    const files = [{ url: "/api/files/abcdefghijklmnopqrstuvwx", name: "a.png", type: "image/png" }];
    const text = convertAll(side("files"), "text", [files]);
    expect(text.out).toEqual([null]);
    expect(text.lost).toBe(1);
    expect(convertAll(side("text"), "files", ["a.png"]).lost).toBe(1);
    const formula = convertAll(side("text"), "formula", ["x", null]);
    expect(formula.out).toEqual([null, null]);
    expect(formula.lost).toBe(1);
  });
});

describe("retypeViewConfig", () => {
  const config: ViewConfig = {
    filters: [
      { propertyId: "p", op: "equals", value: "a" },
      { type: "group", combinator: "or", rules: [{ propertyId: "p", op: "is_empty" }, { propertyId: "q", op: "is_empty" }] },
    ],
    sorts: [{ propertyId: "p", direction: "asc" }, { propertyId: "q", direction: "desc" }],
    groupBy: "p",
    groupOrder: ["a", "b"],
    hiddenGroups: ["b"],
    collapsedGroups: ["a"],
    dateBy: "p",
    calculations: { p: "sum", q: "count_all" },
    form: { questions: [{ propertyId: "p" }], defaults: { p: "a", q: "x" } },
    hidden: ["p"],
    columnWidths: { p: 300 },
  };

  it("drops what the old type set up and keeps the column's place and look", () => {
    const next = retypeViewConfig(config, "p", "select", { type: "text", options: {} });
    expect(next.filters).toEqual([{ type: "group", combinator: "or", rules: [{ propertyId: "q", op: "is_empty" }] }]);
    expect(next.sorts).toEqual(config.sorts);
    expect(next.groupBy).toBeUndefined();
    expect(next.groupOrder).toBeUndefined();
    expect(next.collapsedGroups).toBeUndefined();
    expect(next.dateBy).toBeUndefined();
    expect(next.calculations).toEqual({ q: "count_all" });
    expect(next.form?.questions).toEqual([{ propertyId: "p" }]);
    expect(next.form?.defaults).toEqual({ q: "x" });
    expect(next.hidden).toEqual(["p"]);
    expect(next.columnWidths).toEqual({ p: 300 });
  });

  it("keeps groups whose keys are option ids that carried over", () => {
    const next = retypeViewConfig(config, "p", "select", { type: "status", options: {} });
    expect(next.groupBy).toBe("p");
    expect(next.groupOrder).toEqual(["a", "b"]);
    expect(next.hiddenGroups).toEqual(["b"]);
  });

  it("takes a property Leafdesk works out off forms, and its sorts when it can't sort", () => {
    const next = retypeViewConfig(config, "p", "text", { type: "created_time", options: {} });
    expect(next.form?.questions).toEqual([]);
    expect(next.dateBy).toBe("p");
    const relation = retypeViewConfig(config, "p", "text", { type: "relation", options: {} });
    expect(relation.sorts).toEqual([{ propertyId: "q", direction: "desc" }]);
  });
});

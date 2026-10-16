import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import { cellText, clampRange, moveRange, pastedGrid, planPaste, rangeBounds, toTsv, type PasteColumn, type PasteInput } from "./table-clipboard";

const size = { rows: 5, cols: 4 };

describe("moveRange", () => {
  it("moves the active cell and collapses the range onto it", () => {
    const range = { anchor: { row: 1, col: 1 }, focus: { row: 3, col: 2 } };
    expect(moveRange(range, "ArrowDown", false, size)).toEqual({ anchor: { row: 2, col: 1 }, focus: { row: 2, col: 1 } });
    expect(moveRange(range, "ArrowLeft", false, size)).toEqual({ anchor: { row: 1, col: 0 }, focus: { row: 1, col: 0 } });
  });

  it("stretches the far corner with Shift and keeps the anchor", () => {
    const range = { anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } };
    const down = moveRange(range, "ArrowDown", true, size);
    const right = moveRange(down, "ArrowRight", true, size);
    expect(right).toEqual({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 2 } });
    expect(rangeBounds(moveRange(moveRange(range, "ArrowUp", true, size), "ArrowLeft", true, size))).toEqual({
      top: 0,
      bottom: 1,
      left: 0,
      right: 1,
    });
  });

  it("stops at the table's edges", () => {
    const corner = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
    expect(moveRange(corner, "ArrowUp", false, size)).toEqual(corner);
    expect(moveRange(corner, "ArrowLeft", true, size)).toEqual(corner);
    const last = { anchor: { row: 4, col: 3 }, focus: { row: 4, col: 3 } };
    expect(moveRange(last, "ArrowDown", false, size)).toEqual(last);
    expect(moveRange(last, "ArrowRight", false, size)).toEqual(last);
  });
});

describe("clampRange", () => {
  it("keeps a range inside a table that shrank", () => {
    const range = { anchor: { row: 9, col: 1 }, focus: { row: 2, col: 7 } };
    expect(clampRange(range, size)).toEqual({ anchor: { row: 4, col: 1 }, focus: { row: 2, col: 3 } });
    expect(clampRange(range, { rows: 0, cols: 4 })).toBeNull();
  });

  it("returns the same range when it still fits", () => {
    const range = { anchor: { row: 1, col: 1 }, focus: { row: 2, col: 2 } };
    expect(clampRange(range, size)).toBe(range);
  });
});

describe("toTsv and pastedGrid", () => {
  it("writes cells the way spreadsheets copy them", () => {
    expect(toTsv([["a", 1, null], ["b\tc", 'say "hi"', "two\nlines"]])).toBe('a\t1\t\n"b\tc"\t"say ""hi"""\t"two\nlines"');
  });

  it("guards text a spreadsheet would run as a formula, and takes the guard off when pasted back", () => {
    const tsv = toTsv([["=SUM(A1:A3)", -5, "-done"]]);
    expect(tsv).toBe("'=SUM(A1:A3)\t-5\t'-done");
    expect(pastedGrid(tsv)).toEqual([["=SUM(A1:A3)", "-5", "-done"]]);
  });

  it("reads back what it wrote", () => {
    const cells = [
      ["Name", "Notes"],
      ["Tea", "green\nand black"],
      ["Coffee", 'a "strong" one'],
    ];
    expect(pastedGrid(toTsv(cells))).toEqual(cells);
  });

  it("reads a spreadsheet's 3×3 copy, with Windows line ends and a last line break", () => {
    expect(pastedGrid("a\t1\tyes\r\nb\t2\tno\r\nc\t3\tyes\r\n")).toEqual([
      ["a", "1", "yes"],
      ["b", "2", "no"],
      ["c", "3", "yes"],
    ]);
  });

  it("evens out short rows", () => {
    expect(pastedGrid("a\tb\nc\n")).toEqual([
      ["a", "b"],
      ["c", ""],
    ]);
  });

  it("pastes a single line as one cell, commas and quotes included", () => {
    expect(pastedGrid("Smith, John")).toEqual([["Smith, John"]]);
    expect(pastedGrid('"quoted" text\n')).toEqual([['"quoted" text']]);
    expect(pastedGrid("")).toEqual([]);
  });

  it("pastes plain lines as one column", () => {
    expect(pastedGrid("one\ntwo\nthree")).toEqual([["one"], ["two"], ["three"]]);
  });
});

describe("cellText", () => {
  const prop = (type: PropertyType, options: PropertyOptions = {}) => ({ id: "p", name: "P", type, options });
  const ctx = {
    titleOf: new Map([["r1", "Linked row"]]),
    nameOf: new Map([["u1", "Ada"]]),
    fileText: (f: { name: string; url: string }) => `${f.name} (${f.url})`,
  };

  it("writes values as exports do", () => {
    const select = prop("select", { options: [{ id: "o1", name: "Done", color: "green" }] });
    expect(cellText(select, "o1", ctx)).toBe("Done");
    expect(cellText(prop("person"), ["u1", "u2"], ctx)).toBe("Ada, u2");
    expect(cellText(prop("relation"), ["r1"], ctx)).toBe("Linked row");
    expect(cellText(prop("checkbox"), true, ctx)).toBe("true");
    expect(cellText(prop("number"), 0.25, ctx)).toBe(0.25);
    expect(cellText(prop("date"), "2026-10-12", ctx)).toBe("2026-10-12");
    expect(cellText(prop("text"), "", ctx)).toBeNull();
    expect(cellText(prop("text"), undefined, ctx)).toBeNull();
  });

  it("writes a checklist one item per line", () => {
    const items = [
      { id: "1", text: "Buy", checked: true },
      { id: "2", text: "Cook", checked: false },
    ];
    expect(cellText(prop("checklist"), items, ctx)).toBe("[x] Buy\n[ ] Cook");
  });
});

describe("planPaste", () => {
  const columns: PasteColumn[] = [
    { key: "title", type: "title" },
    { key: "n", type: "number" },
    { key: "done", type: "checkbox" },
    { key: "when", type: "date" },
    { key: "f", type: "formula" },
  ];
  const base: PasteInput = {
    grid: [],
    target: { top: 0, left: 0, bottom: 0, right: 0 },
    rowIds: ["r0", "r1", "r2"],
    columns,
    canEdit: () => true,
    canAddRows: true,
    timeZone: "UTC",
  };

  it("writes a 3×3 paste from the target cell on, read as each column reads it", () => {
    const plan = planPaste({
      ...base,
      grid: pastedGrid("Tea\t1.234,5\tyes\nCoffee\t15%\tno\nCocoa\t-3\t1\n"),
      target: { top: 0, left: 0, bottom: 0, right: 0 },
    });
    expect(plan.updates).toEqual([
      { rowId: "r0", title: "Tea", values: { n: 1234.5, done: true } },
      { rowId: "r1", title: "Coffee", values: { n: 0.15, done: false } },
      { rowId: "r2", title: "Cocoa", values: { n: -3, done: true } },
    ]);
    expect(plan.newRows).toEqual([]);
    expect(plan).toMatchObject({ invalid: 0, skipped: 0 });
  });

  it("starts where the range starts, not at the first column", () => {
    const plan = planPaste({ ...base, grid: [["7", "x"]], target: { top: 1, left: 1, bottom: 2, right: 2 } });
    expect(plan.updates).toEqual([{ rowId: "r1", values: { n: 7, done: true } }]);
  });

  it("adds rows for what goes past the last one", () => {
    const plan = planPaste({ ...base, grid: [["a"], ["b"], ["c"], ["d"]], target: { top: 1, left: 0, bottom: 1, right: 0 } });
    expect(plan.updates.map((u) => u.rowId)).toEqual(["r1", "r2"]);
    expect(plan.newRows).toEqual([
      { title: "c", values: {} },
      { title: "d", values: {} },
    ]);
  });

  it("leaves rows past the last one out when the table can't add them", () => {
    const plan = planPaste({ ...base, canAddRows: false, grid: [["a"], ["b"]], target: { top: 2, left: 0, bottom: 2, right: 0 } });
    expect(plan.updates).toEqual([{ rowId: "r2", title: "a", values: {} }]);
    expect(plan.newRows).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it("keeps empty rows between pasted ones but drops them at the end", () => {
    const plan = planPaste({ ...base, rowIds: [], grid: [["a"], [""], ["c"], [""]] });
    expect(plan.newRows).toEqual([{ title: "a", values: {} }, { values: {} }, { title: "c", values: {} }]);
  });

  it("clears existing cells for empty pasted ones, and leaves a new row's empty", () => {
    const plan = planPaste({ ...base, rowIds: ["r0"], grid: [["", ""], ["", "yes"]], target: { top: 0, left: 1, bottom: 0, right: 1 } });
    expect(plan.updates).toEqual([{ rowId: "r0", values: { n: null, done: null } }]);
    expect(plan.newRows).toEqual([{ values: { done: true } }]);
  });

  it("fills the whole range with a single pasted value", () => {
    const plan = planPaste({ ...base, grid: [["42"]], target: { top: 0, left: 1, bottom: 2, right: 1 } });
    expect(plan.updates).toEqual([
      { rowId: "r0", values: { n: 42 } },
      { rowId: "r1", values: { n: 42 } },
      { rowId: "r2", values: { n: 42 } },
    ]);
  });

  it("counts cells that don't fit their column and cells it may not write", () => {
    const plan = planPaste({
      ...base,
      grid: [["x", "lots", "maybe", "soon", "=1+1", "extra"]],
      canEdit: (_row, key) => key !== "title",
    });
    expect(plan.updates).toEqual([]);
    // "lots", "maybe" and "soon" don't read as a number, a checkbox and a date.
    expect(plan.invalid).toBe(3);
    // The title it may not change, the formula, and the cell past the last column.
    expect(plan.skipped).toBe(3);
  });

  it("reads a pasted column's dates the way that column writes them", () => {
    const plan = planPaste({ ...base, grid: [["3/4/2026"], ["25/4/2026"]], target: { top: 0, left: 3, bottom: 0, right: 3 } });
    // A day over 12 makes the column day first, so 3/4 is 3 April.
    expect(plan.updates.map((u) => u.values.when)).toEqual(["2026-04-03", "2026-04-25"]);
  });
});

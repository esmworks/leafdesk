import { describe, expect, it } from "vitest";
import { inlineText, tableAsDatabase, tableRecords, type TableBlockContent } from "./table-to-database";

const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: t, styles });
const cell = (content: unknown[], props: Record<string, number> = {}) => ({ type: "tableCell" as const, content, props });

describe("inlineText", () => {
  it("keeps the text of styled runs and links and drops the formatting", () => {
    expect(inlineText([text("Bold", { bold: true }), text(" and "), { type: "link", href: "https://x.test", content: [text("link")] }])).toBe(
      "Bold and link",
    );
    expect(inlineText("plain")).toBe("plain");
    expect(inlineText([{ type: "mention", props: { id: "u1" } }])).toBe("");
    expect(inlineText(undefined)).toBe("");
  });
});

describe("tableRecords", () => {
  it("reads cells given as table cells or as bare inline content", () => {
    const content: TableBlockContent = {
      type: "tableContent",
      rows: [{ cells: [cell([text("Name")]), cell([text("Owner")])] }, { cells: [[text("Alpha")], [text("Ayşe")]] }],
    };
    expect(tableRecords(content)).toEqual([
      ["Name", "Owner"],
      ["Alpha", "Ayşe"],
    ]);
  });

  it("puts a merged cell's text in its first position and leaves the positions it covers empty", () => {
    const content: TableBlockContent = {
      rows: [
        { cells: [cell([text("A")]), cell([text("B")]), cell([text("C")])] },
        // "wide" spans two columns, "tall" two rows.
        { cells: [cell([text("wide")], { colspan: 2 }), cell([text("tall")], { rowspan: 2 })] },
        { cells: [cell([text("x")]), cell([])] },
      ],
    };
    expect(tableRecords(content)).toEqual([
      ["A", "B", "C"],
      ["wide", "", "tall"],
      ["x", "", ""],
    ]);
  });

  it("pads short rows and ignores a span past the last row", () => {
    const content: TableBlockContent = { rows: [{ cells: [cell([text("A")]), cell([text("B")])] }, { cells: [cell([text("1")], { rowspan: 3 })] }] };
    expect(tableRecords(content)).toEqual([
      ["A", "B"],
      ["1", ""],
    ]);
    expect(tableRecords({ rows: [] })).toEqual([]);
    expect(tableRecords(null)).toEqual([]);
  });
});

describe("tableAsDatabase", () => {
  it("names blank and repeated headers the way imports do and keeps every row", () => {
    expect(tableAsDatabase([["Task", "", "Notes", "notes"], ["Write", "x", "", "y"], ["", "", "", ""]])).toEqual({
      headers: ["Task", "Column 2", "Notes", "notes 2"],
      rows: [
        ["Write", "x", "", "y"],
        ["", "", "", ""],
      ],
    });
  });

  it("makes a database without rows from a header alone", () => {
    expect(tableAsDatabase([["Name", "Date"]])).toEqual({ headers: ["Name", "Date"], rows: [] });
  });
});

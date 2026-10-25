import { describe, expect, it } from "vitest";
import { markdownLosses } from "./markdown-source";
import { restoreTableLooks } from "./table-looks";

type Look = { backgroundColor?: string; textColor?: string; textAlignment?: string };
const cell = (text: string, look: Look = {}) => ({
  type: "tableCell",
  props: { colspan: 1, rowspan: 1, backgroundColor: "default", textColor: "default", textAlignment: "left", ...look },
  content: text ? [{ type: "text", text, styles: {} }] : [],
});
const table = (id: string | undefined, rows: (string | [string, Look])[][], extra: Record<string, unknown> = {}) => ({
  ...(id ? { id } : {}),
  type: "table",
  props: { textColor: "default" },
  content: {
    type: "tableContent",
    columnWidths: rows[0].map(() => null),
    headerRows: 1,
    rows: rows.map((row) => ({ cells: row.map((c) => (Array.isArray(c) ? cell(c[0], c[1]) : cell(c))) })),
    ...extra,
  },
  children: [],
});
const looks = (block: ReturnType<typeof table>) => block.content.rows.map((row) => row.cells.map((c) => c.props.backgroundColor));

describe("restoreTableLooks", () => {
  const styled = () =>
    table(
      "t1",
      [
        ["Name", ["Score", { backgroundColor: "blue", textAlignment: "right" }]],
        ["Ada", ["10", { textColor: "red" }]],
      ],
      { columnWidths: [240, 90], headerRows: undefined, headerCols: 1 },
    );

  it("gives a rewritten table its widths, header settings and cell looks back", () => {
    const rewritten = table("t1", [["Name", "Score"], ["Ada", "10"]]);
    restoreTableLooks([rewritten], [styled()]);
    expect(rewritten.content.columnWidths).toEqual([240, 90]);
    expect(rewritten.content).not.toHaveProperty("headerRows");
    expect((rewritten.content as Record<string, unknown>).headerCols).toBe(1);
    expect(rewritten.content.rows[0].cells[1].props).toMatchObject({ backgroundColor: "blue", textAlignment: "right" });
    expect(rewritten.content.rows[1].cells[1].props.textColor).toBe("red");
    expect(markdownLosses([styled()], [rewritten])).toEqual([]);
  });

  it("follows a table whose text changed when it is the only one that did", () => {
    const rewritten = table(undefined, [["Name", "Score"], ["Ada", "12"]]);
    restoreTableLooks([{ type: "paragraph", children: [] } as never, rewritten], [styled()]);
    expect(rewritten.content.columnWidths).toEqual([240, 90]);
    expect(rewritten.content.rows[1].cells[1].props.textColor).toBe("red");
  });

  it("keeps rows' looks with their rows when rows are added", () => {
    const rewritten = table("t1", [["Name", "Score"], ["Bob", "3"], ["Ada", "10"]]);
    restoreTableLooks([rewritten], [styled()]);
    expect(looks(rewritten)).toEqual([["default", "blue"], ["default", "default"], ["default", "default"]]);
    expect(rewritten.content.rows[1].cells[1].props.textColor).toBe("default");
    expect(rewritten.content.rows[2].cells[1].props.textColor).toBe("red");
  });

  it("leaves a table whose columns changed as written", () => {
    const rewritten = table("t1", [["Name", "Score", "Rank"], ["Ada", "10", "1"]]);
    restoreTableLooks([rewritten], [styled()]);
    expect(rewritten.content.columnWidths).toEqual([null, null, null]);
    expect(rewritten.content.headerRows).toBe(1);
    expect(looks(rewritten).flat().every((color) => color === "default")).toBe(true);
  });

  it("doesn't guess between several tables that changed", () => {
    const a = table(undefined, [["x", "y"]]);
    const b = table(undefined, [["z", "w"]]);
    restoreTableLooks([a], [styled(), { ...styled(), id: "t2" }]);
    restoreTableLooks([a, b], [styled()]);
    expect(a.content.columnWidths).toEqual([null, null]);
    expect(b.content.columnWidths).toEqual([null, null]);
  });

  it("finds tables inside other blocks, and keeps a cell look Markdown set", () => {
    const rewritten = table("t1", [["Name", ["Score", { backgroundColor: "green" }]], ["Ada", "10"]]);
    const toggle = { type: "toggleListItem", children: [rewritten] };
    restoreTableLooks([toggle as never], [{ type: "toggleListItem", children: [styled()] } as never]);
    expect(rewritten.content.columnWidths).toEqual([240, 90]);
    expect(rewritten.content.rows[0].cells[1].props.backgroundColor).toBe("green");
  });
});

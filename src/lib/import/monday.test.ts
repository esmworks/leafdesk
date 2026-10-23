import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { toXlsx } from "../xlsx";
import { AYSE_EMAIL, MONDAY_BOARD, mondayWorkbook } from "./board-fixtures";
import { guessMondayColumn, isMondayBoard, mondayItemId, readMondayExport, readMondayRows } from "./monday";

const board = () => readMondayExport("Marketing.xlsx", mondayWorkbook());
const item = (b: ReturnType<typeof board>, title: string) => b.items.find((i) => i.title === title)!;
const cell = (b: ReturnType<typeof board>, title: string, column: string) => item(b, title).cells[b.columns.findIndex((c) => c.name === column)];

describe("Monday.com board exports", () => {
  it("reads the board's name, its groups in order and each item followed by its subitems", () => {
    const b = board();
    expect(b.source).toBe("monday");
    expect(b.title).toBe("Marketing board");
    expect(b.groups).toEqual(["This week", "Next week"]);
    expect(b.items.map((i) => [i.title, i.parent === null ? null : b.items[i.parent].title, b.groups[i.group!]])).toEqual([
      ["Launch campaign", null, "This week"],
      ["Write brief", "Launch campaign", "This week"],
      ["Book ads", "Launch campaign", "This week"],
      ["Plan event", null, "This week"],
      // Named in the Subitems column only: a subitem by name.
      ["Retro", null, "Next week"],
      ["Collect feedback", "Retro", "Next week"],
      // An item with nothing but its name is still an item, not a group.
      ["Newsletter", null, "Next week"],
    ]);
    expect(item(b, "Launch campaign").id).toBe("1001");
  });

  it("guesses each column's kind from its name and values, the subitems' columns joining the items' of the same name", () => {
    expect(board().columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      "Owner:person",
      "Status:status",
      "Due date:date",
      "Timeline:date",
      "Budget:number",
      "Tags:multi_select",
      "Brief:url",
      "Contact:email",
      "Phone:phone",
      "Approved:checkbox",
      "Notes:text",
      "Location:place",
      "Date:date",
    ]);
    expect(board().columns[1].options).toEqual([
      { name: "Working on it", group: "in_progress" },
      { name: "Done", group: "done" },
      { name: "Stuck", group: "in_progress" },
    ]);
  });

  it("keeps the cells as the export wrote them", () => {
    const b = board();
    expect(cell(b, "Launch campaign", "Timeline")).toBe("2026-10-01 - 2026-10-15");
    expect(cell(b, "Launch campaign", "Due date")).toBe("2026-10-20");
    expect(cell(b, "Write brief", "Owner")).toBe("Bob Stone");
    expect(cell(b, "Write brief", "Date")).toBe("2026-10-05");
    expect(cell(b, "Launch campaign", "Contact")).toBe(AYSE_EMAIL);
    expect(cell(b, "Retro", "Status")).toBe("");
  });

  it("makes the Dependency column the items' dependencies, by name, and counts the names it doesn't find", () => {
    const b = board();
    expect(item(b, "Launch campaign").blockedBy.map((i) => b.items[i].title)).toEqual(["Plan event"]);
    expect(b.unlinked).toEqual([
      { column: "Dependency", count: 1 },
      { column: "Item Name", count: 1 },
    ]);
  });

  it("makes updates comments, oldest first, and leaves out other sheets", () => {
    const b = board();
    expect(item(b, "Launch campaign").comments).toEqual([
      { author: "Bob Stone", date: "2026-10-01T08:00:00.000Z", text: "Kickoff on Monday, see https://acme.monday.com/boards/123/pulses/1002" },
      { author: "Ayşe Yılmaz", date: "2026-10-02T09:30:00.000Z", text: "The brief is ready." },
    ]);
    expect(b.otherSheets).toEqual(["Chart data"]);
  });

  it("reads the same sheet saved as CSV", () => {
    const csv = MONDAY_BOARD.map((row) =>
      row.map((v) => (v === null || v === undefined ? "" : typeof v === "object" ? v.date : `"${String(v).replace(/"/g, '""')}"`)).join(","),
    ).join("\n");
    const b = readMondayExport("Marketing.csv", strToU8(csv));
    expect(b.items.map((i) => i.title)).toEqual(board().items.map((i) => i.title));
    expect(b.columns.map((c) => c.type)).toEqual(board().columns.map((c) => c.type));
    expect(b.items.every((i) => !i.comments.length)).toBe(true);
  });

  it("takes a board without its name on top, named after the file", () => {
    const b = readMondayRows([["Group one"], ["Name", "Status"], ["A", "Done"]], { fileName: "Ops board.xlsx" });
    expect(b.title).toBe("Ops board");
    expect(b.groups).toEqual(["Group one"]);
  });

  it("leads links to items of the board to them", () => {
    expect(mondayItemId("https://acme.monday.com/boards/123/pulses/1002")).toBe("1002");
    expect(mondayItemId("https://acme.monday.com/boards/123/views/9/pulses/1002?x=1")).toBe("1002");
    expect(mondayItemId("https://monday.com.evil.example/boards/1/pulses/2")).toBeNull();
  });

  it("guesses kinds by name only when the values fit", () => {
    expect(guessMondayColumn("Status", ["Done", "Stuck", ""]).type).toBe("status");
    expect(guessMondayColumn("People", ["Ada, Bob"]).type).toBe("person");
    expect(guessMondayColumn("Phone", ["call me"]).type).toBe("text");
    expect(guessMondayColumn("Timeline", ["2026-10-01 - 2026-10-05", ""]).type).toBe("date");
    expect(guessMondayColumn("Week", ["2026-10-01 - 2026-10-05"]).type).toBe("date");
    expect(guessMondayColumn("Priority", ["High", "Low", "High"]).type).toBe("select");
    expect(guessMondayColumn("Location", ["Galata Tower (41.0256, 28.9741)"]).type).toBe("place");
    expect(guessMondayColumn("Location", ["Galata Tower, Istanbul"]).type).toBe("text");
  });

  it("refuses other workbooks and files", () => {
    expect(isMondayBoard([["Name"], ["A"]])).toBe(false);
    // A plain table: its header on top, not under a group.
    expect(isMondayBoard([["Name", "Points"], ["A", "1"]])).toBe(false);
    expect(() => readMondayExport("x.xlsx", toXlsx([["just one cell"]]))).toThrow(expect.objectContaining({ code: "badMonday" }));
    expect(() => readMondayExport("x.csv", strToU8("one\ntwo\n"))).toThrow(expect.objectContaining({ code: "badMonday" }));
  });
});

import { describe, expect, it } from "vitest";
import {
  cellRange,
  cellText,
  cellValue,
  columnLetter,
  defaultHeaderRow,
  kindOf,
  MAX_SHEET_TEXT,
  parseSheetLink,
  planWrites,
  readGrid,
  readMeta,
  serialDay,
  serialTime,
  sheetHeaders,
  sheetItems,
  repeatedKeys,
  sameValue,
  sheetInput,
  sheetRange,
  sheetsAccess,
  sheetsWriteAccess,
  type PendingWrite,
  type SheetCell,
} from "./sheets-sync";

const ID = "17AGsQSFVti7KUDNYLvq682TwnZF4N5MZKZpeNI_-lyc";
const text = (value: string): SheetCell => ({ effectiveValue: { stringValue: value }, formattedValue: value });
const num = (value: number, shown = String(value), type?: string): SheetCell => ({
  effectiveValue: { numberValue: value },
  formattedValue: shown,
  ...(type ? { effectiveFormat: { numberFormat: { type } } } : {}),
});
const bool = (value: boolean): SheetCell => ({ effectiveValue: { boolValue: value }, formattedValue: value ? "TRUE" : "FALSE" });

describe("parseSheetLink", () => {
  it("reads the spreadsheet and the sheet from a link", () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?pli=1&gid=878363657#gid=878363657`)).toEqual({ spreadsheetId: ID, sheetId: 878363657 });
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toEqual({ spreadsheetId: ID, sheetId: 0 });
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?gid=12`)).toEqual({ spreadsheetId: ID, sheetId: 12 });
    expect(parseSheetLink(` https://docs.google.com/spreadsheets/d/${ID}/edit `)).toEqual({ spreadsheetId: ID, sheetId: null });
    expect(parseSheetLink(ID)).toEqual({ spreadsheetId: ID, sheetId: null });
  });

  it("refuses what isn't one", () => {
    expect(parseSheetLink(`https://docs.google.com/document/d/${ID}/edit`)).toBeNull();
    expect(parseSheetLink(`https://docs.google.com.evil.test/spreadsheets/d/${ID}/edit`)).toBeNull();
    expect(parseSheetLink(`http://docs.google.com/spreadsheets/d/${ID}/edit`)).toBeNull();
    expect(parseSheetLink("short")).toBeNull();
    expect(parseSheetLink(42)).toBeNull();
  });
});

describe("sheetsAccess", () => {
  const row = { status: "ready", tools: [{ name: "get_spreadsheet" }], chatTools: [] as string[] };
  it("lets owners read through a ready connection with the tool", () => {
    expect(sheetsAccess(row, "owner")).toBe(true);
    expect(sheetsAccess({ ...row, status: "needsAuth" }, "owner")).toBe(false);
    expect(sheetsAccess({ ...row, tools: [{ name: "get_values" }] }, "owner")).toBe(false);
  });

  it("lets members only when an owner allowed the chat the tool, and guests never", () => {
    expect(sheetsAccess(row, "member")).toBe(false);
    expect(sheetsAccess({ ...row, chatTools: ["get_spreadsheet"] }, "member")).toBe(true);
    expect(sheetsAccess({ ...row, chatTools: ["get_spreadsheet"] }, "membership_admin")).toBe(true);
    expect(sheetsAccess({ ...row, chatTools: ["get_spreadsheet"] }, "guest")).toBe(false);
  });
});

describe("reading the answers", () => {
  it("reads a spreadsheet's sheets, the first one's id included", () => {
    const meta = readMeta({
      properties: { title: "İzmir Canlı Stok", timeZone: "Europe/Istanbul" },
      sheets: [
        { properties: { title: "BATARYA STOK", gridProperties: { rowCount: 2246, columnCount: 27, frozenRowCount: 3 } } },
        { properties: { sheetId: 1784875648, title: "EKSTRA STOK", gridProperties: { rowCount: 10, columnCount: 2 } } },
      ],
    });
    expect(meta).toEqual({
      title: "İzmir Canlı Stok",
      timeZone: "Europe/Istanbul",
      sheets: [
        { sheetId: 0, title: "BATARYA STOK", rows: 2246, columns: 27, frozenRows: 3 },
        { sheetId: 1784875648, title: "EKSTRA STOK", rows: 10, columns: 2, frozenRows: 0 },
      ],
    });
    expect(defaultHeaderRow(meta!.sheets[0])).toBe(3);
    expect(defaultHeaderRow(meta!.sheets[1])).toBe(1);
    expect(readMeta({ error: "no" })).toBeNull();
  });

  it("reads the grid of one range, empty rows as []", () => {
    expect(readGrid({ sheets: [{ data: [{ rowData: [{ values: [text("A")] }, {}, { values: [num(1)] }] }] }] })).toEqual([[text("A")], [], [num(1)]]);
    expect(readGrid({ sheets: [{}] })).toEqual([]);
    expect(readGrid({})).toBeNull();
  });

  it("names the range from the header row down, quoting the sheet's name", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
    expect(sheetRange({ title: "BATARYA STOK", rows: 2246, columns: 27 }, 3)).toBe("'BATARYA STOK'!A3:AA2246");
    expect(sheetRange({ title: "Joe's", rows: 1, columns: 1 }, 2)).toBe("'Joe''s'!A2:A2");
  });
});

describe("columns", () => {
  it("names columns by their header, leaving empty ones out and numbering repeats", () => {
    expect(sheetHeaders([text("ÜRÜN"), text(""), text("  Liste   fiyatı "), {}, text("Durum"), text("durum"), num(2026)])).toEqual([
      { index: 0, name: "ÜRÜN" },
      { index: 2, name: "Liste fiyatı" },
      { index: 4, name: "Durum" },
      { index: 5, name: "durum (2)" },
      { index: 6, name: "2026" },
    ]);
  });

  it("gives a column the kind all its values share, else text", () => {
    expect(kindOf([num(432), num(164.5, "164,5", "NUMBER"), undefined, text(" ")])).toBe("number");
    expect(kindOf([num(-1, "-1", "NUMBER"), text("EKSİK YOK")])).toBe("text");
    expect(kindOf([num(46322, "27.10.2026", "DATE")])).toBe("date");
    expect(kindOf([num(46322.5, "27.10.2026 12:00", "DATE_TIME")])).toBe("time");
    expect(kindOf([num(0.5, "12:00", "TIME")])).toBe("text");
    expect(kindOf([bool(true), bool(false)])).toBe("checkbox");
    expect(kindOf([num(46322, "27.10.2026", "DATE"), num(3)])).toBe("text");
    expect(kindOf([{ effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO" } } }, num(1)])).toBe("number");
    expect(kindOf([])).toBe("text");
  });
});

describe("values", () => {
  it("turns date serials into days and times in the spreadsheet's zone", () => {
    expect(serialDay(46322)).toBe("2026-10-27");
    expect(serialDay(25569)).toBe("1970-01-01");
    expect(serialTime(46322.5, "Europe/Istanbul")).toBe("2026-10-27T09:00:00.000Z");
    expect(serialTime(46322.5, "UTC")).toBe("2026-10-27T12:00:00.000Z");
    expect(serialTime(46322.5, "Not/AZone")).toBe("2026-10-27T12:00:00.000Z");
  });

  it("writes each cell as its column's property takes it", () => {
    expect(cellValue("number", num(164.54988000000003, "164,5"), "UTC")).toBe(164.54988);
    expect(cellValue("number", text("x"), "UTC")).toBeNull();
    expect(cellValue("checkbox", bool(true), "UTC")).toBe(true);
    expect(cellValue("checkbox", undefined, "UTC")).toBeNull();
    expect(cellValue("date", num(46322, "27.10.2026", "DATE"), "UTC")).toBe("2026-10-27");
    expect(cellValue("time", num(46322.25, "", "DATE_TIME"), "Europe/Istanbul")).toBe("2026-10-27T03:00:00.000Z");
    // Text shows what the sheet shows: a number as the spreadsheet's language writes it.
    expect(cellValue("text", num(-1, "-1"), "UTC")).toBe("-1");
    expect(cellValue("text", num(1234.5, "1.234,50 ₺"), "UTC")).toBe("1.234,50 ₺");
    expect(cellValue("text", text("x".repeat(MAX_SHEET_TEXT + 5)), "UTC")).toHaveLength(MAX_SHEET_TEXT);
    expect(cellValue("text", { effectiveValue: { errorValue: {} }, formattedValue: "#DIV/0!" }, "UTC")).toBeNull();
    expect(cellText({ effectiveValue: { numberValue: 3 } })).toBe("3");
  });
});

describe("sheetItems", () => {
  const grid = [
    [text("ÜRÜN"), text("LİSTE FİYATI"), text("DURUM"), text("Ad")],
    [text("GNA 1.500-1 N"), num(432), num(-1, "-1"), text("Birinci")],
    [text("GNA 2.000-1 N"), num(542), text("EKSİK YOK")],
    [],
    [text("  "), num(1)],
    [text("GNA 2.500-1 N"), {}, num(-11, "-11"), text("")],
  ];
  const mapping = {
    key: "p_key",
    columns: [
      { column: "LİSTE FİYATI", property: "p_price", kind: "number" as const },
      { column: "DURUM", property: "p_state", kind: "text" as const },
      { column: "Gone", property: "p_gone", kind: "text" as const },
    ],
  };

  it("makes a row of each line with a key, named by the title column or else its key", () => {
    expect(sheetItems(grid, { keyColumn: "ÜRÜN", titleColumn: "Ad", headerRow: 1 }, mapping, "UTC")).toEqual([
      { key: "GNA 1.500-1 N", title: "Birinci", values: { p_key: "GNA 1.500-1 N", p_price: 432, p_state: "-1" } },
      { key: "GNA 2.000-1 N", title: "GNA 2.000-1 N", values: { p_key: "GNA 2.000-1 N", p_price: 542, p_state: "EKSİK YOK" } },
      { key: "GNA 2.500-1 N", title: "GNA 2.500-1 N", values: { p_key: "GNA 2.500-1 N", p_price: null, p_state: "-11" } },
    ]);
  });

  it("has nothing to go on when the key column's header is gone", () => {
    expect(sheetItems(grid, { keyColumn: "SKU", titleColumn: "Ad", headerRow: 1 }, mapping, "UTC")).toBeNull();
  });
});

describe("sheetItems by place", () => {
  // Payments: the same day, firm and amount more than once, and no column of ids.
  const grid = [
    [text("Tarih"), text("Firma"), text("Tutar"), text(""), text("Not")],
    [num(46330, "04.11.2026", "DATE"), text("Frigoduman"), num(2390)],
    [num(46330, "04.11.2026", "DATE"), text("Frigoduman"), num(2390)],
    [],
    [text(" "), {}, {}, text("ignored: no header")],
    [{}, {}, {}, {}, text("only a note")],
  ];
  const mapping = {
    key: "p_row",
    columns: [
      { column: "Tarih", property: "p_day", kind: "date" as const },
      { column: "Firma", property: "p_firm", kind: "text" as const },
      { column: "Tutar", property: "p_amount", kind: "number" as const },
      { column: "Not", property: "p_note", kind: "text" as const },
    ],
  };

  it("makes a row of each line with anything in a named column, keyed by its sheet row, repeats and all", () => {
    expect(sheetItems(grid, { keyColumn: "", titleColumn: "Firma", headerRow: 3 }, mapping, "UTC")).toEqual([
      { key: "4", title: "Frigoduman", values: { p_row: 4, p_day: "2026-11-04", p_firm: "Frigoduman", p_amount: 2390, p_note: null } },
      { key: "5", title: "Frigoduman", values: { p_row: 5, p_day: "2026-11-04", p_firm: "Frigoduman", p_amount: 2390, p_note: null } },
      { key: "8", title: "", values: { p_row: 8, p_day: null, p_firm: null, p_amount: null, p_note: "only a note" } },
    ]);
  });

  it("counts the rows a keyed run leaves out for repeating a key", () => {
    const keyed = sheetItems(grid, { keyColumn: "Tarih", titleColumn: "Firma", headerRow: 3 }, mapping, "UTC")!;
    expect(keyed.map((item) => item.key)).toEqual(["04.11.2026", "04.11.2026"]);
    expect(repeatedKeys(keyed)).toBe(1);
    expect(repeatedKeys([])).toBe(0);
  });
});

describe("sheetsWriteAccess", () => {
  const tools = ["get_spreadsheet", "update_values", "insert_dimension"].map((name) => ({ name }));
  it("lets owners write through a connection with the write tools", () => {
    expect(sheetsWriteAccess({ status: "ready", tools, chatTools: [] }, "owner")).toBe(true);
    expect(sheetsWriteAccess({ status: "ready", tools: tools.slice(0, 2), chatTools: [] }, "owner")).toBe(false);
  });

  it("lets members only when an owner allowed the chat to read and write", () => {
    expect(sheetsWriteAccess({ status: "ready", tools, chatTools: ["get_spreadsheet"] }, "member")).toBe(false);
    expect(sheetsWriteAccess({ status: "ready", tools, chatTools: ["get_spreadsheet", "update_values", "insert_dimension"] }, "member")).toBe(true);
    expect(sheetsWriteAccess({ status: "ready", tools, chatTools: ["get_spreadsheet", "update_values", "insert_dimension"] }, "guest")).toBe(false);
  });
});

describe("writing values", () => {
  it("writes each kind as a cell takes it", () => {
    expect(sheetInput("number", 12.5, "UTC")).toBe(12.5);
    expect(sheetInput("number", null, "UTC")).toBe("");
    expect(sheetInput("checkbox", true, "UTC")).toBe(true);
    expect(sheetInput("checkbox", undefined, "UTC")).toBe(false);
    expect(sheetInput("date", "2026-10-27", "UTC")).toBe(46322);
    expect(sheetInput("date", "2026-10-27/2026-10-29", "UTC")).toBe(46322);
    expect(sheetInput("time", "2026-10-27T09:00:00.000Z", "Europe/Istanbul")).toBe(46322.5);
    expect(sheetInput("text", "acil", "UTC")).toBe("acil");
    expect(sheetInput("text", "+90 532 000 0000", "UTC")).toBe("+90 532 000 0000");
  });

  it("writes no text a sheet could take for a formula", () => {
    expect(sheetInput("text", "=IMPORTDATA(A1)", "UTC")).toBeUndefined();
    expect(sheetInput("number", "12", "UTC")).toBeUndefined();
  });

  it("compares values as their kind, empty ones alike", () => {
    expect(sameValue("checkbox", false, undefined)).toBe(true);
    expect(sameValue("text", "", null)).toBe(true);
    expect(sameValue("text", " a ", "a")).toBe(true);
    expect(sameValue("number", 1, 2)).toBe(false);
    expect(sameValue("time", "2026-10-27T09:00:20.000Z", "2026-10-27T09:00:00.000Z")).toBe(true);
    expect(sameValue("date", "2026-10-27/2026-10-28", "2026-10-27")).toBe(true);
  });

  it("names a range of cells", () => {
    expect(cellRange("Stok's", 5, 1, 3)).toBe("'Stok''s'!B5:D5");
    expect(cellRange("Stok", 9, 0, 2, 3)).toBe("'Stok'!A9:B11");
  });
});

describe("planWrites", () => {
  const formula = (value: number): SheetCell => ({ ...num(value), userEnteredValue: { formulaValue: "=B2*2" } });
  // Header on row 3: key, title, price, total (a formula), arrived.
  const grid = [
    [text("CODE"), text("NAME"), text("PRICE"), text("TOTAL"), text("ARRIVED")],
    [text("A1"), text("Battery"), num(10), formula(20), bool(false)],
    [text("B2"), text("Cable"), num(5), formula(10), bool(true)],
    [],
  ];
  const query = { keyColumn: "CODE", titleColumn: "NAME", headerRow: 3 };
  const mapping = {
    key: "key",
    columns: [
      { column: "PRICE", property: "price", kind: "number" as const },
      { column: "TOTAL", property: "total", kind: "number" as const },
      { column: "ARRIVED", property: "arrived", kind: "checkbox" as const },
    ],
  };
  const entry = (id: string, before: Record<string, unknown>, created = false): PendingWrite => ({ id, rowId: id, created, before });
  const rows = (values: Record<string, { title: string; properties: Record<string, unknown> }>) => new Map(Object.entries(values));

  it("writes a change where the sheet still has the value from before it", () => {
    const plan = planWrites(grid, query, mapping, "UTC", [entry("r1", { price: 10, title: "Battery" })], rows({ r1: { title: "Big battery", properties: { key: "A1", price: 12 } } }));
    expect(plan.updates).toEqual([{ row: 4, column: 1, values: ["Big battery", 12] }]);
    expect(plan.done).toEqual(["r1"]);
    expect(plan.settled.r1).toEqual({ price: 12, title: "Big battery" });
  });

  it("leaves the sheet's value where it changed there too, and never writes formulas or the key", () => {
    const plan = planWrites(
      grid,
      query,
      mapping,
      "UTC",
      [entry("r1", { price: 8, total: 20, key: "A1" })],
      rows({ r1: { title: "Battery", properties: { key: "A1", price: 12, total: 99 } } }),
    );
    expect(plan.updates).toEqual([]);
    expect(plan.done).toEqual(["r1"]);
    expect(plan.settled.r1).toEqual({ price: 10 });
  });

  it("skips cells between changes and drops rows that left the sheet or are gone", () => {
    const plan = planWrites(
      grid,
      query,
      mapping,
      "UTC",
      [entry("r2", { price: 5, arrived: true }), entry("gone", { price: 1 }), entry("left", { price: 1 })],
      rows({ r2: { title: "Cable", properties: { key: "B2", price: 6 } }, left: { title: "x", properties: { key: "Z9", price: 2 } } }),
    );
    expect(plan.updates).toEqual([{ row: 5, column: 2, values: [6, null, false] }]);
    expect(plan.done.sort()).toEqual(["gone", "left", "r2"]);
    expect(plan.appends).toEqual([]);
  });

  it("adds rows made in Leafdesk below the last row, and waits for one without a key", () => {
    const plan = planWrites(
      grid,
      query,
      mapping,
      "UTC",
      [entry("n1", {}, true), entry("n2", {}, true)],
      rows({ n1: { title: "Charger", properties: { key: "C3", price: 30, arrived: true } }, n2: { title: "", properties: {} } }),
    );
    expect(plan.appends).toEqual([["C3", "Charger", 30, null, true]]);
    expect(plan.appendAt).toBe(6);
    expect(plan.done).toEqual(["n1"]);
  });

  it("finds a new row's key in its title when the key column names rows", () => {
    const plan = planWrites(grid, { ...query, titleColumn: "CODE" }, mapping, "UTC", [entry("n1", {}, true)], rows({ n1: { title: "D4", properties: { price: 1 } } }));
    expect(plan.appends).toEqual([["D4", null, 1, null, null]]);
    expect(plan.keyed).toEqual([{ rowId: "n1", key: "D4" }]);
  });

  it("leaves a new row alone whose title is another row's key, matched in the sheet or not", () => {
    const keyed = { ...query, titleColumn: "CODE" };
    const plan = planWrites(grid, keyed, mapping, "UTC", [entry("n1", {}, true), entry("n2", {}, true)], rows({ n1: { title: "A1", properties: { price: 1 } }, n2: { title: "Z9", properties: {} } }), new Set(["A1", "Z9"]));
    expect(plan).toMatchObject({ updates: [], appends: [], keyed: [] });
    expect(plan.done).toEqual(["n1", "n2"]);
  });

  it("gives a new row matched in the sheet its key when no row has it", () => {
    const plan = planWrites(grid, { ...query, titleColumn: "CODE" }, mapping, "UTC", [entry("n1", {}, true)], rows({ n1: { title: "A1", properties: {} } }));
    expect(plan.keyed).toEqual([{ rowId: "n1", key: "A1" }]);
    expect(plan.appends).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { toCsv } from "../csv";
import {
  cellValue,
  csvTable,
  decodeText,
  detectDateFormat,
  detectDelimiter,
  guessColumn,
  guessTitleColumn,
  INVALID,
  parseCheckbox,
  parseChecklist,
  parseCsv,
  parseDate,
  parseNumber,
  percentColumn,
  splitList,
} from "./csv";

describe("parseCsv", () => {
  it("reads quoted fields with separators, quotes and line breaks", () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
    ]);
  });

  it("drops a BOM and takes LF, CRLF and CR line ends", () => {
    expect(parseCsv("﻿a,b\n1,2\r3,4\r\n5,6")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("keeps empty fields, including a trailing one", () => {
    expect(parseCsv("a,,c,\n")).toEqual([["a", "", "c", ""]]);
  });

  it("detects semicolon and tab separated files", () => {
    expect(detectDelimiter("Ad;Tutar\nElma;3,5")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
    expect(parseCsv("Ad;Tutar\nElma;3,5")).toEqual([
      ["Ad", "Tutar"],
      ["Elma", "3,5"],
    ]);
  });

  it("reads back what the CSV export writes", () => {
    const exported = toCsv([
      ["Name", "Amount", "Note"],
      ["=HYPERLINK()", -2, 'with "quotes", commas'],
    ]);
    expect(csvTable(exported)).toEqual({
      headers: ["Name", "Amount", "Note"],
      rows: [["=HYPERLINK()", "-2", 'with "quotes", commas']],
    });
  });
});

describe("csvTable", () => {
  it("names blank headers, numbers repeated ones and pads short rows", () => {
    expect(csvTable("Name,,name, Tags \nA\n,,,\nB,1,2,3,4")).toEqual({
      headers: ["Name", "Column 2", "name 2", "Tags"],
      rows: [
        ["A", "", "", ""],
        ["B", "1", "2", "3"],
      ],
    });
  });

  it("is empty for an empty file", () => {
    expect(csvTable("")).toEqual({ headers: [], rows: [] });
  });
});

describe("decodeText", () => {
  it("reads UTF-8, and Windows-1254 when the bytes aren't UTF-8", () => {
    expect(decodeText(new TextEncoder().encode("Şişli,İzmir"))).toBe("Şişli,İzmir");
    expect(decodeText(new Uint8Array([0xde, 0x69, 0xfe, 0x6c, 0x69]))).toBe("Şişli");
  });
});

describe("values", () => {
  it("reads numbers the usual ways", () => {
    expect(parseNumber("1234.5")).toBe(1234.5);
    expect(parseNumber("-3")).toBe(-3);
    expect(parseNumber("1,234,567.89")).toBe(1234567.89);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("3,14")).toBe(3.14);
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("12 abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("reads amounts and percentages, a percentage as its fraction", () => {
    expect(parseNumber("₺1.234,50")).toBe(1234.5);
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("12 €")).toBe(12);
    expect(parseNumber("15%")).toBe(0.15);
    expect(parseNumber("%7")).toBe(0.07);
    expect(parseNumber("12,5 %")).toBe(0.125);
    expect(parseNumber("%")).toBeNull();
    expect(cellValue("number", "0.15")).toBe(0.15);
    expect(guessColumn(["15%", "7,5%", ""]).type).toBe("number");
    expect(percentColumn(["15%", "7,5%", ""])).toBe(true);
    expect(percentColumn(["15%", "7"])).toBe(false);
    expect(percentColumn(["", " "])).toBe(false);
  });

  it("reads checkboxes in English, Turkish, German, Spanish and French", () => {
    expect(parseCheckbox("Yes")).toBe(true);
    expect(parseCheckbox("EVET")).toBe(true);
    expect(parseCheckbox("Hayır")).toBe(false);
    expect(parseCheckbox("Ja")).toBe(true);
    expect(parseCheckbox("Sí")).toBe(true);
    expect(parseCheckbox("NON")).toBe(false);
    expect(parseCheckbox("false")).toBe(false);
    expect(parseCheckbox("1")).toBe(true);
    expect(parseCheckbox("1", { numbers: false })).toBeNull();
    expect(parseCheckbox("maybe")).toBeNull();
  });

  it("reads dates in each format and refuses impossible ones", () => {
    expect(parseDate("2026-09-28", "iso")).toBe("2026-09-28");
    expect(parseDate("2026-09-28T10:00:00.000Z", "iso")).toBe("2026-09-28T10:00:00.000Z");
    expect(parseDate("2026/9/8", "ymd")).toBe("2026-09-08");
    expect(parseDate("28.09.2026", "dmy")).toBe("2026-09-28");
    expect(parseDate("09/28/2026", "mdy")).toBe("2026-09-28");
    expect(parseDate("28/09/2026", "dmy-slash")).toBe("2026-09-28");
    expect(parseDate("September 28, 2026", "text")).toBe("2026-09-28");
    expect(parseDate("May 1, 2026 → May 3, 2026", "text")).toBe("2026-05-01/2026-05-03");
    // Times: in their own zone when written with one, else in the importing person's.
    expect(parseDate("October 12, 2026 2:30 PM", "text", "Europe/Istanbul")).toBe("2026-10-12T11:30:00.000Z");
    expect(parseDate("October 12, 2026 2:30 PM (GMT+3) → 4:00 PM", "text")).toBe("2026-10-12T11:30:00.000Z/2026-10-12T13:00:00.000Z");
    expect(parseDate("October 12, 2026 9:00 AM (UTC) → October 13, 2026 9:00 AM (UTC)", "text")).toBe(
      "2026-10-12T09:00:00.000Z/2026-10-13T09:00:00.000Z",
    );
    expect(parseDate("28.09.2026 14:30", "dmy", "UTC")).toBe("2026-09-28T14:30:00.000Z");
    expect(parseDate("09/28/2026 2:30 PM", "mdy", "UTC")).toBe("2026-09-28T14:30:00.000Z");
    // Ends that don't fit keep the start.
    expect(parseDate("May 3, 2026 → May 1, 2026", "text")).toBe("2026-05-03");
    expect(parseDate("May 3, 2026 → May 4, 2026 10:00 AM", "text")).toBe("2026-05-03");
    expect(parseDate("2026-02-30", "iso")).toBeNull();
    expect(parseDate("Meeting notes", "text")).toBeNull();
  });

  it("picks a column's date format from all of its values", () => {
    expect(detectDateFormat(["03/04/2026", "05/06/2026"])).toBe("mdy");
    expect(detectDateFormat(["03/04/2026", "25/06/2026"])).toBe("dmy-slash");
    expect(detectDateFormat(["1.2.2026", ""])).toBe("dmy");
    expect(detectDateFormat(["2026-01-01", "soon"])).toBeNull();
  });

  it("splits lists and reads checklists", () => {
    expect(splitList("a, b; B ,, c")).toEqual(["a", "b", "c"]);
    expect(parseChecklist("[x] Done\n[ ] Open\nPlain")).toEqual([
      { text: "Done", checked: true },
      { text: "Open", checked: false },
      { text: "Plain", checked: false },
    ]);
  });
});

describe("guessColumn", () => {
  it("guesses numbers, but not codes with leading zeros or long ids", () => {
    expect(guessColumn(["1", "2.5", "", "-3"]).type).toBe("number");
    expect(guessColumn(["01234", "56789"]).type).toBe("text");
    expect(guessColumn(["1234567890123456789", "1"]).type).toBe("text");
  });

  it("guesses checkboxes, dates, URLs and emails", () => {
    expect(guessColumn(["Yes", "No", ""]).type).toBe("checkbox");
    expect(guessColumn(["2026-01-02", "2026-03-04"])).toEqual({ type: "date", dateFormat: "iso" });
    expect(guessColumn(["https://a.example", "http://b.example/x"]).type).toBe("url");
    expect(guessColumn(["a@example.com", "b@example.com"]).type).toBe("email");
  });

  it("guesses selects for few repeating values and multi-selects for lists of them", () => {
    expect(guessColumn(["Done", "Todo", "Done", "Doing"])).toEqual({ type: "select", options: ["Done", "Todo", "Doing"] });
    expect(guessColumn(["a, b", "b", "c, a"])).toEqual({ type: "multi_select", options: ["a", "b", "c"] });
  });

  it("keeps free text as text", () => {
    expect(guessColumn(["one thing", "another thing", "a third"]).type).toBe("text");
    expect(guessColumn(["Hello, world", "Goodbye, moon", "Hi, there"]).type).toBe("text");
    expect(guessColumn(["line\nbreak", "line\nbreak"]).type).toBe("text");
    expect(guessColumn(["", " "]).type).toBe("text");
  });

  it("finds the title column by name, else the first", () => {
    expect(guessTitleColumn(["Id", "Name", "Tags"])).toBe(1);
    expect(guessTitleColumn(["Id", "Título", "Etiquetas"])).toBe(1);
    expect(guessTitleColumn(["Id", "TITRE"])).toBe(1);
    expect(guessTitleColumn(["Kod", "Başlık"])).toBe(1);
    expect(guessTitleColumn(["Id", "Tags"])).toBe(0);
  });
});

describe("cellValue", () => {
  it("turns cells into the values row writes take", () => {
    expect(cellValue("number", "1,5")).toBe(1.5);
    expect(cellValue("checkbox", "evet")).toBe(true);
    expect(cellValue("date", "28.09.2026")).toBe("2026-09-28");
    expect(cellValue("date", "03/04/2026", { dateFormat: "dmy-slash" })).toBe("2026-04-03");
    expect(cellValue("multi_select", "a, b")).toEqual(["a", "b"]);
    expect(cellValue("person", "Ada, bob@example.com")).toEqual(["Ada", "bob@example.com"]);
    expect(cellValue("email", "mailto:a@example.com")).toBe("a@example.com");
    expect(cellValue("text", "  keep spaces ")).toBe("  keep spaces ");
    expect(cellValue("checklist", "[x] a\n[ ] b")).toEqual([
      { text: "a", checked: true },
      { text: "b", checked: false },
    ]);
  });

  it("is null for empty cells and INVALID for ones that don't fit", () => {
    expect(cellValue("number", "  ")).toBeNull();
    expect(cellValue("number", "n/a")).toBe(INVALID);
    expect(cellValue("date", "soon")).toBe(INVALID);
    expect(cellValue("url", "example.com")).toBe(INVALID);
    expect(cellValue("files", "x.png")).toBe(INVALID);
  });
});

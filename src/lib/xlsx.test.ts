import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { columnName, dateSerial, sheetName, toXlsx, xmlText } from "./xlsx";

const parts = (data: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(data)).map(([name, bytes]) => [name, strFromU8(bytes)]));

describe("toXlsx", () => {
  it("writes the parts of a workbook with one sheet", () => {
    const files = parts(toXlsx([["Name"], ["A"]], { name: "Tasks" }));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(files["xl/workbook.xml"]).toContain('<sheet name="Tasks" sheetId="1" r:id="rId1"/>');
    // Two fills are required, the second gray125.
    expect(files["xl/styles.xml"]).toMatch(/<fills count="2">.*gray125.*<\/fills>/);
  });

  it("types cells: numbers, booleans, dates, date-times and inline text", () => {
    const sheet = parts(
      toXlsx([
        ["Name", "Points", "Done", "Due", "Created"],
        ["Write docs", 3.5, true, { date: "2025-01-01" }, { date: "2025-01-01T18:00:00.000Z" }],
        ["Ship", -2, false, null, undefined],
      ]),
    )["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>3.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="C3" t="b"><v>0</v></c>');
    expect(sheet).toContain('<c r="D2" s="2"><v>45658</v></c>');
    expect(sheet).toContain('<c r="E2" s="3"><v>45658.75</v></c>');
    expect(sheet).not.toContain('r="D3"');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    // Child order the schema requires.
    expect(sheet.indexOf("<sheetViews>")).toBeLessThan(sheet.indexOf("<cols>"));
    expect(sheet.indexOf("<cols>")).toBeLessThan(sheet.indexOf("<sheetData>"));
  });

  it("keeps text as typed: no formula guard, markup escaped, invalid characters dropped", () => {
    const sheet = parts(toXlsx([["H"], ["=SUM(A1)"], ["a < b & \"c\""], ["bell\u0007 _x0041_"], ["  two\nlines "]]))["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain(">=SUM(A1)</t>");
    expect(sheet).toContain(">a &lt; b &amp; &quot;c&quot;</t>");
    expect(sheet).toContain(">bell _x005F_x0041_</t>");
    expect(sheet).toContain('<t xml:space="preserve">  two\nlines </t>');
  });

  it("writes text where a date isn't one", () => {
    const sheet = parts(toXlsx([["H"], [{ date: "soon" }], [{ date: "1899-01-01" }]]))["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain(">soon</t>");
    expect(sheet).toContain(">1899-01-01</t>");
  });
});

describe("sheetName", () => {
  it("drops characters sheet names can't have and keeps 31", () => {
    expect(sheetName("Q1 [draft]: a/b\\c?*")).toBe("Q1 draft a b c");
    expect(sheetName("'quoted'")).toBe("quoted");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("  ")).toBe("Sheet1");
    expect(sheetName("History")).toBe("History_");
  });
});

describe("columnName", () => {
  it("counts A to Z, then AA", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("dateSerial", () => {
  it("counts days from the 1900 system's day 0", () => {
    expect(dateSerial("2025-01-01")).toEqual({ serial: 45658, time: false });
    expect(dateSerial("1900-03-01")).toEqual({ serial: 61, time: false });
    expect(dateSerial("2025-01-01T06:00:00Z")).toEqual({ serial: 45658.25, time: true });
    expect(dateSerial("1900-02-28")).toBeNull();
    expect(dateSerial("not a date")).toBeNull();
  });
});

describe("xmlText", () => {
  it("drops unpaired surrogates and keeps pairs", () => {
    expect(xmlText("a\uD800b😀")).toBe("ab😀");
  });
});

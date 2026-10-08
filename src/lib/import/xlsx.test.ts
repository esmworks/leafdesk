import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { toXlsx } from "../xlsx";
import { guessColumn } from "./csv";
import { ImportError, WarningList } from "./result";
import { cellColumn, decodeXml, formatKind, readWorkbook, scanXml, serialText, spreadsheetTable, workbookTable } from "./xlsx";

/*
 * A workbook written the way a spreadsheet application writes one (not by lib/xlsx): shared
 * strings with rich text runs and phonetic hints, styles with built-in and custom date formats,
 * a formula with its cached value, sparse rows and cells, a hidden sheet, a theme part, absolute
 * and relative relationship targets.
 */

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function workbookXml({ date1904 = false } = {}) {
  return (
    `${HEAD}<workbook ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15">` +
    `<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>` +
    `<workbookPr ${date1904 ? 'date1904="1" ' : ""}defaultThemeVersion="166925"/>` +
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15">` +
    `<x15ac:absPath url="C:\\Users\\me\\Documents\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent>` +
    `<bookViews><workbookView xWindow="-110" yWindow="-110" windowWidth="19420" windowHeight="10420" activeTab="0"/></bookViews>` +
    `<sheets><sheet name="Tasks" sheetId="1" r:id="rId1"/><sheet name="Lookup" sheetId="3" state="hidden" r:id="rId3"/>` +
    `<sheet name="Notes &amp; ideas" sheetId="2" r:id="rId2"/></sheets>` +
    `<calcPr calcId="191029"/></workbook>`
  );
}

const SHARED = [
  "Name",
  "Done",
  "Due",
  "Points",
  "Notes",
  "Write docs",
  // Rich text: two runs, and a phonetic hint that isn't part of the text.
  '<r><rPr><b/><sz val="11"/></rPr><t>Ship</t></r><r><t xml:space="preserve"> it</t></r><rPh sb="0" eb="4"><t>シップ</t></rPh>',
  "a_x000D_b",
  "Fish &amp; chips &lt;3",
  "Weight",
];

const sharedStringsXml = () =>
  `${HEAD}<sst ${NS} count="${SHARED.length}" uniqueCount="${SHARED.length}">` +
  SHARED.map((s) => (s.startsWith("<r>") ? `<si>${s}</si>` : `<si><t>${s}</t></si>`)).join("") +
  `</sst>`;

const stylesXml = () =>
  `${HEAD}<styleSheet ${NS}>` +
  `<numFmts count="3"><numFmt numFmtId="164" formatCode="d/m/yyyy;@"/><numFmt numFmtId="165" formatCode="0.00&quot; kg&quot;"/>` +
  `<numFmt numFmtId="166" formatCode="[h]:mm:ss"/></numFmts>` +
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  // Style records outside cellXfs don't count: this one would make style 1 a number.
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// Shared string indexes: 0 Name, 1 Done, 2 Due, 3 Points, 4 Notes, 5 Write docs, 6 Ship it, 7 a\rb, 8 Fish & chips <3, 9 Weight.
const tasksSheetXml = () =>
  `${HEAD}<worksheet ${NS} xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
  `<dimension ref="A1:G6"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>` +
  `<sheetFormatPr defaultRowHeight="14.5" x14ac:dyDescent="0.35"/><sheetData>` +
  // The header: E1 is left blank (no cell at all).
  `<row r="1" spans="1:7"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>` +
  `<c r="D1" t="s"><v>3</v></c><c r="F1" t="s"><v>4</v></c><c r="G1" t="s"><v>9</v></c></row>` +
  // A boolean, a built-in date, a formula with its cached value, an inline string, a custom number format.
  `<row r="2" spans="1:7"><c r="A2" t="s"><v>5</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" s="1"><v>45658</v></c>` +
  `<c r="D2"><f>1+2</f><v>3</v></c><c r="F2" t="inlineStr"><is><t>Inline note</t></is></c><c r="G2" s="3"><v>2.5</v></c></row>` +
  // Rows 3 and 4 don't exist; row 5 has a custom day-first date with a time it doesn't show,
  // a formula giving text, and a percentage.
  `<row r="5" spans="1:7"><c r="A5" t="s"><v>6</v></c><c r="B5" t="b"><v>0</v></c><c r="C5" s="2"><v>45659.5</v></c>` +
  `<c r="D5" s="6"><v>0.25</v></c><c r="F5" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="G5"><v>0.30000000000000004</v></c></row>` +
  // A date with a time, an error, a value under the blank header, cells without references.
  `<row r="6"><c r="A6" t="s"><v>8</v></c><c r="B6" s="5"><v>1.5</v></c><c r="C6" s="4"><v>45658.75</v></c>` +
  `<c r="D6" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="E6"><v>7</v></c><c><v>8</v></c><c t="s"><v>7</v></c></row>` +
  // Formatting but no values: not a row.
  `<row r="7" spans="1:7"><c r="A7" s="1"/><c r="B7" s="2"></c></row>` +
  `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

const notesSheetXml = () =>
  `${HEAD}<worksheet ${NS}><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Idea</t></is></c></row>` +
  `<row r="3"><c r="B3" t="inlineStr"><is><t>Fly</t></is></c></row></sheetData></worksheet>`;

function fixture({ date1904 = false, parts = {} as Record<string, string | null> } = {}) {
  const files: Record<string, string | null> = {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels":
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml({ date1904 }),
    "xl/_rels/workbook.xml.rels":
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/>` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId6" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId5" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId4" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": tasksSheetXml(),
    "xl/worksheets/sheet2.xml": notesSheetXml(),
    "xl/worksheets/sheet3.xml": `${HEAD}<worksheet ${NS}><sheetData/></worksheet>`,
    "xl/sharedStrings.xml": sharedStringsXml(),
    "xl/styles.xml": stylesXml(),
    "xl/theme/theme1.xml": `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"/>`,
    "docProps/app.xml": `${HEAD}<Properties/>`,
    ...parts,
  };
  return zipSync(Object.fromEntries(Object.entries(files).flatMap(([name, xml]) => (xml === null ? [] : [[name, strToU8(xml)]]))));
}

function failure(fn: () => unknown) {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe("readWorkbook", () => {
  it("lists the visible worksheets", () => {
    expect(readWorkbook(fixture()).sheets).toEqual([{ name: "Tasks" }, { name: "Notes & ideas" }]);
  });

  it("reads a sheet's values the way a CSV file would have them", () => {
    const table = readWorkbook(fixture()).table(0);
    expect(table.headers).toEqual(["Name", "Done", "Due", "Points", "Column 5", "Notes", "Weight"]);
    expect(table.rows).toEqual([
      ["Write docs", "TRUE", "2025-01-01", "3", "", "Inline note", "2.5"],
      ["Ship it", "FALSE", "2025-01-02", "0.25", "", "xy", "0.3"],
      ["Fish & chips <3", "36:00:00", "2025-01-01T18:00:00", "", "7", "8", "a\rb"],
    ]);
  });

  it("feeds the CSV import's type guessing", () => {
    const { rows } = readWorkbook(fixture()).table(0);
    const column = (i: number) => rows.slice(0, 2).map((r) => r[i]);
    expect(guessColumn(column(1)).type).toBe("checkbox");
    expect(guessColumn(column(2))).toEqual({ type: "date", dateFormat: "iso" });
    expect(guessColumn(column(3)).type).toBe("number");
  });

  it("reads another sheet, its header the first row with anything in it", () => {
    expect(readWorkbook(fixture()).table(1)).toEqual({ headers: ["Column 1", "Idea"], rows: [["", "Fly"]] });
  });

  it("counts dates from 1904 when the workbook says so", () => {
    const { rows } = readWorkbook(fixture({ date1904: true })).table(0);
    expect(rows[0][2]).toBe("2029-01-02");
  });

  it("reads elements with a namespace prefix", () => {
    const x = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const book = fixture({
      parts: {
        "xl/worksheets/sheet1.xml": `<x:worksheet ${x}><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      },
    });
    expect(readWorkbook(book).table(0)).toEqual({ headers: ["Name"], rows: [["1"]] });
  });

  it("works without shared strings or styles", () => {
    const book = fixture({
      parts: {
        "xl/sharedStrings.xml": null,
        "xl/styles.xml": null,
        "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData><row><c t="inlineStr"><is><t>N</t></is></c></row><row><c><v>45658</v></c></row></sheetData></worksheet>`,
      },
    });
    expect(readWorkbook(book).table(0)).toEqual({ headers: ["N"], rows: [["45658"]] });
  });

  it("refuses old and password-protected workbooks, and files that aren't workbooks", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(failure(() => readWorkbook(ole))).toBe("unsupportedWorkbook");
    expect(failure(() => readWorkbook(strToU8("Name,Done\n")))).toBe("badWorkbook");
    expect(failure(() => readWorkbook(zipSync({ "a.txt": strToU8("hi") })))).toBe("badWorkbook");
    expect(failure(() => readWorkbook(fixture({ parts: { "xl/workbook.xml": `<workbook ${NS}><sheets>` } })))).toBe("badWorkbook");
    expect(
      failure(() => readWorkbook(fixture({ parts: { "xl/worksheets/sheet1.xml": `<!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet ${NS}/>` } })).table(0)),
    ).toBe("badWorkbook");
    expect(failure(() => readWorkbook(fixture({ parts: { "xl/worksheets/sheet1.xml": null } })).table(0))).toBe("badWorkbook");
    const badString = `<worksheet ${NS}><sheetData><row><c t="s"><v>99</v></c></row></sheetData></worksheet>`;
    expect(failure(() => readWorkbook(fixture({ parts: { "xl/worksheets/sheet1.xml": badString } })).table(0))).toBe("badWorkbook");
  });

  it("stops at the CSV import's row and column limits", () => {
    const rows = Array.from({ length: 5002 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    const tall = fixture({ parts: { "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>` } });
    expect(failure(() => readWorkbook(tall).table(0))).toBe("tooManyRows");
    const exact = fixture({ parts: { "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${rows.split("</row>").slice(0, 5001).join("</row>")}</row></sheetData></worksheet>` } });
    expect(readWorkbook(exact).table(0).rows).toHaveLength(5000);
    const wide = fixture({ parts: { "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData><row r="1"><c r="CW1"><v>1</v></c></row></sheetData></worksheet>` } });
    expect(failure(() => readWorkbook(wide).table(0))).toBe("tooManyColumns");
  });
});

describe("workbookTable", () => {
  it("imports the first sheet and reports the others as left out", () => {
    const warnings = new WarningList();
    expect(workbookTable(fixture(), null, warnings).headers[0]).toBe("Name");
    expect(warnings.list).toEqual([{ code: "skipped", path: "Notes & ideas", reason: "otherSheet" }]);
  });

  it("imports the chosen sheet without warnings", () => {
    const warnings = new WarningList();
    expect(workbookTable(fixture(), 1, warnings).headers).toEqual(["Column 1", "Idea"]);
    expect(warnings.list).toEqual([]);
  });
});

describe("spreadsheetTable", () => {
  it("reads CSV files as CSV and workbooks as workbooks", () => {
    expect(spreadsheetTable("a.csv", strToU8("Name,N\nA,1\n"))).toEqual({ headers: ["Name", "N"], rows: [["A", "1"]] });
    expect(spreadsheetTable("a.xlsx", fixture()).headers[0]).toBe("Name");
    // A workbook whatever its name says.
    expect(spreadsheetTable("export.csv", fixture()).headers[0]).toBe("Name");
    expect(failure(() => spreadsheetTable("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))).toBe("unsupportedWorkbook");
  });
});

describe("round trip", () => {
  it("reads back what lib/xlsx writes", () => {
    const data = toXlsx([
      ["Name", "Points", "Done", "Due", "Created", "Notes"],
      ["=SUM(A1)", 3.5, true, { date: "2025-01-01" }, { date: "2025-01-01T18:30:15.000Z" }, "  two\nlines "],
      ["_x0041_ & <b>", -2, false, null, null, "emoji 😀"],
      ["", 1e21, null, { date: "9999-12-31" }, null, null],
    ]);
    expect(workbookTable(data)).toEqual({
      headers: ["Name", "Points", "Done", "Due", "Created", "Notes"],
      rows: [
        ["=SUM(A1)", "3.5", "TRUE", "2025-01-01", "2025-01-01T18:30:15", "  two\nlines "],
        ["_x0041_ & <b>", "-2", "FALSE", "", "", "emoji 😀"],
        ["", "1e+21", "", "9999-12-31", "", ""],
      ],
    });
  });
});

describe("formatKind", () => {
  it("tells dates, times and plain numbers apart", () => {
    expect(formatKind("General")).toBeNull();
    expect(formatKind("0.00")).toBeNull();
    expect(formatKind('0.00" days"')).toBeNull();
    expect(formatKind("[Red]#,##0;[Blue]-#,##0")).toBeNull();
    expect(formatKind("0.00E+00")).toBeNull();
    expect(formatKind("d/m/yyyy;@")).toBe("date");
    expect(formatKind("[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy")).toBe("date");
    expect(formatKind("mmm")).toBe("date");
    expect(formatKind("h:mm AM/PM")).toBe("time");
    expect(formatKind("[h]:mm:ss")).toBe("time");
    expect(formatKind("[mm]")).toBe("time");
    expect(formatKind("yyyy-mm-dd hh:mm")).toBe("dateTime");
  });
});

describe("serialText", () => {
  it("counts the 1900 system's missing leap day", () => {
    expect(serialText(1, "date", false)).toBe("1900-01-01");
    expect(serialText(59, "date", false)).toBe("1900-02-28");
    expect(serialText(61, "date", false)).toBe("1900-03-01");
    expect(serialText(0, "date", false)).toBeNull();
    expect(serialText(0, "date", true)).toBe("1904-01-01");
  });

  it("rounds to the second and writes times", () => {
    expect(serialText(45658.999999, "dateTime", false)).toBe("2025-01-02");
    expect(serialText(45658 + 1 / 3, "dateTime", false)).toBe("2025-01-01T08:00:00");
    expect(serialText(0.75, "time", false)).toBe("18:00:00");
    expect(serialText(-1, "date", false)).toBeNull();
    expect(serialText(3e6, "date", false)).toBeNull();
  });
});

describe("scanXml", () => {
  it("reads attributes, entities, CDATA and comments", () => {
    const events: string[] = [];
    scanXml(`<?xml version="1.0"?><!-- c --><a x='1 > 0' y="&quot;q&quot;"><b/>t&#x41;&#66;<![CDATA[<raw>]]></a>`, {
      open: (name, attrs) => events.push(`<${name} ${JSON.stringify(attrs)}>`),
      close: (name) => events.push(`</${name}>`),
      text: (text) => events.push(text),
    });
    expect(events).toEqual([`<a {"x":"1 > 0","y":"\\"q\\""}>`, "<b {}>", "</b>", "tAB", "<raw>", "</a>"]);
  });

  it("refuses XML that isn't well formed", () => {
    for (const bad of ["<a><b></a>", "<a>", "<a x=1/>", "<a>&nope;</a>", "<a/><b/>", "text<a/>", "<a>&amp</a>"]) {
      expect(() => scanXml(bad, { text: () => {} }), bad).toThrow();
    }
  });
});

describe("decodeXml and cellColumn", () => {
  it("decode references and cell columns", () => {
    expect(decodeXml("a &lt;b&gt; &amp; &apos;c&apos; &#128512;")).toBe("a <b> & 'c' 😀");
    expect([cellColumn("A1"), cellColumn("Z9"), cellColumn("AA10"), cellColumn("$C$7"), cellColumn("1A")]).toEqual([0, 25, 26, 2, null]);
  });
});

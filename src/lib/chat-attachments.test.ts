import { describe, expect, it } from "vitest";
import { attachmentCsv, readCsvAttachment } from "./chat-attachment-table";
import {
  CHAT_ATTACHMENT_NAME,
  CHAT_CSV_MAX_CHARS,
  CHAT_CSV_MAX_COLUMNS,
  CHAT_CSV_MAX_ROWS,
  chatFileKind,
  cleanAttachmentName,
  uniqueAttachmentName,
} from "./chat-attachments";

describe("files attached to the AI chat", () => {
  it("knows how to read a file by its type, or its name where the type says little", () => {
    expect(chatFileKind("", "Orders.CSV")).toBe("csv");
    expect(chatFileKind("text/csv", "export")).toBe("csv");
    // What some systems call a CSV file.
    expect(chatFileKind("application/vnd.ms-excel", "orders.csv")).toBe("csv");
    expect(chatFileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet.xlsx")).toBe("document");
    expect(chatFileKind("application/pdf", "a.pdf")).toBe("document");
    expect(chatFileKind("application/octet-stream", "brief.docx")).toBe("document");
    expect(chatFileKind("image/png; charset=binary", "shot.png")).toBe("image");
    expect(chatFileKind("text/markdown", "notes.md")).toBe("text");
    expect(chatFileKind("", "notes.txt")).toBe("text");
    // Not images providers take, nor anything else.
    expect(chatFileKind("image/svg+xml", "logo.svg")).toBeNull();
    expect(chatFileKind("application/x-msdownload", "setup.exe")).toBeNull();
    expect(chatFileKind("text/html", "page.pdf")).toBeNull();
  });

  it("reads a file's table, with the delimiter it uses", () => {
    const read = readCsvAttachment("Name;Amount\nAli;10\nAyşe;20\n");
    expect(read).toEqual({ ok: true, table: { headers: ["Name", "Amount"], rows: [["Ali", "10"], ["Ayşe", "20"]] } });
  });

  it("refuses files that are empty, too large, too long or too wide", () => {
    expect(readCsvAttachment("")).toEqual({ ok: false, problem: "empty" });
    expect(readCsvAttachment("a\n".repeat(CHAT_CSV_MAX_CHARS))).toEqual({ ok: false, problem: "tooLarge" });
    expect(readCsvAttachment(`n\n${"1\n".repeat(CHAT_CSV_MAX_ROWS + 1)}`)).toEqual({ ok: false, problem: "tooManyRows" });
    expect(readCsvAttachment(`n\n${"1\n".repeat(CHAT_CSV_MAX_ROWS)}`).ok).toBe(true);
    const wide = Array.from({ length: CHAT_CSV_MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    expect(readCsvAttachment(`${wide}\n`)).toEqual({ ok: false, problem: "tooManyColumns" });
  });

  it("keeps a name on one line, and short", () => {
    expect(cleanAttachmentName("  my\nfile\u0000.csv ")).toBe("my file .csv");
    expect(cleanAttachmentName("a\tb.csv")).toBe("a b.csv");
    expect(cleanAttachmentName("")).toBe("file");
    expect(cleanAttachmentName("x".repeat(500))).toHaveLength(CHAT_ATTACHMENT_NAME);
  });

  it("gives a file whose name is taken its own", () => {
    expect(uniqueAttachmentName([], "a.csv")).toBe("a.csv");
    expect(uniqueAttachmentName(["A.csv"], "a.csv")).toBe("a (2).csv");
    expect(uniqueAttachmentName(["a.csv", "a (2).csv"], "a.csv")).toBe("a (3).csv");
    expect(uniqueAttachmentName(["data"], "data")).toBe("data (2)");
  });

  it("writes the table for the model as CSV, as many rows as fit, from any row", () => {
    const table = { headers: ["Name", "Note"], rows: [["Ali", "says \"hi\""], ["Ayşe", "a, b"], ["Can", "line\nbreak"]] };
    expect(attachmentCsv(table, { maxChars: 10_000 })).toEqual({ text: 'Name,Note\nAli,"says ""hi"""\nAyşe,"a, b"\nCan,"line\nbreak"', shown: 3 });
    expect(attachmentCsv(table, { maxChars: 30 })).toEqual({ text: 'Name,Note\nAli,"says ""hi"""', shown: 1 });
    expect(attachmentCsv(table, { from: 2, maxChars: 10_000 })).toEqual({ text: 'Name,Note\nCan,"line\nbreak"', shown: 1 });
    // The header always comes, even when no row fits.
    expect(attachmentCsv(table, { maxChars: 5 })).toEqual({ text: "Name,Note", shown: 0 });
  });
});

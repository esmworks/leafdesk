/**
 * What an import reports back (server/import/*, the /api/import route and the import dialog share
 * these). Errors stop an import before anything is kept; warnings describe what an import that went
 * through left out, so the dialog can say so in the user's language.
 */

export const IMPORT_ERROR_CODES = [
  /** The upload is over a size limit (`limit` in bytes). */
  "tooLarge",
  /** More files than an import takes (`limit`). */
  "tooManyFiles",
  /** More pages than an import creates (`limit`). */
  "tooManyPages",
  /** A CSV with more rows or columns than an import takes (`limit`). */
  "tooManyRows",
  "tooManyColumns",
  /** The ZIP can't be read. */
  "badZip",
  /** No Markdown or CSV file in the upload. */
  "nothingToImport",
  /** The CSV has no header row. */
  "emptyCsv",
  /** The Excel workbook can't be read. */
  "badWorkbook",
  /** An old binary workbook (.xls) or one saved with a password: only plain .xlsx files are read. */
  "unsupportedWorkbook",
  /** A Word document (`name`) that can't be read: not a .docx, or damaged. */
  "badDocx",
  /** A Word document (`name`) too large or too complex to read as one page in time. */
  "docxTooComplex",
  /** A PDF (`name`) that can't be read: not a PDF, damaged, or locked with a password. */
  "badPdf",
  /** A PDF (`name`) without a text layer (a scan): there is no text to make a page of. */
  "pdfNoText",
  /** A PDF (`name`) with more pages than an import reads (PDF_LIMITS), or too much text for one page. */
  "pdfTooComplex",
  /** A file (`name`) that isn't an Evernote export (.enex), can't be read as one, or a ZIP holding none. */
  "badEnex",
  /** A file (`name`) that isn't a single-file web page (.mht, .mhtml) or holds no HTML. */
  "badMhtml",
  /** The file isn't a Trello board's JSON export. */
  "badTrello",
  /** The file isn't an Asana project's CSV or JSON export. */
  "badAsana",
  /** The file isn't a Monday.com board exported to Excel (or saved as CSV). */
  "badMonday",
  /** The upload isn't a Confluence space exported as HTML (no page of one in it). */
  "badConfluence",
  /** Merging: no column goes to a property, or two go to the same one. */
  "badMapping",
  /** The destination is missing, in the trash or not editable, or not a database when merging. */
  "noAccess",
  "notADatabase",
  /** Another import of theirs (or too many on the server) is still running. */
  "busy",
  "badRequest",
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export type ImportWarning =
  /** Cells of a column that didn't fit its property (a word in a number column): left empty. */
  | { code: "invalidValues"; column: string; count: number }
  /** A column of another app's export that isn't imported (its creation and edit times: Leafdesk keeps its own). */
  | { code: "leftOutColumn"; column: string }
  /** A relative link or image pointing at a file the upload doesn't have: left as it was. */
  | { code: "missingFile"; path: string; page: string }
  /** A wikilink (`[[Name]]`) naming no file of the upload: left as it was written. */
  | { code: "unresolvedLink"; target: string; page: string }
  /**
   * A file a page shows couldn't be stored (too large, quota): the link was left as it was. A
   * Word document's picture is left out instead, and so is one linked from outside the document
   * (`external`) or of a type pages don't show (`unsupportedType`, such as a Windows metafile).
   */
  | { code: "fileNotStored"; path: string; reason: "tooLarge" | "quotaExceeded" | "failed" | "external" | "unsupportedType" }
  /** A note (`page`: the export and the note's title) held encrypted text, which was left out. */
  | { code: "encryptedText"; page: string }
  /** A saved web page showed more pictures than are copied (`limit`): `count` were left out. */
  | { code: "tooManyImages"; count: number; limit: number }
  /**
   * Files left out: a ZIP inside the ZIP, a database inside a database, a duplicate CSV (or a
   * database's own Markdown file), a Markdown file over the size limit, a file no page shows or
   * links to (there's nowhere to put it), a ZIP entry whose path climbs out of the archive,
   * a file whose path is longer or deeper than an import takes (`deepPath`, see IMPORT_LIMITS),
   * the sheets of a workbook other than the one imported (`path` is the sheet's name), a note of an
   * Evernote export whose content can't be read (`badNote`; `tooLarge` past its limit) and a file
   * of a ZIP of exports that isn't one (`notEnex`).
   */
  | {
      code: "skipped";
      path: string;
      reason: "nestedZip" | "nestedDatabase" | "duplicate" | "tooLarge" | "unused" | "unsafePath" | "deepPath" | "otherSheet" | "badNote" | "notEnex";
    };

/** At most this many warnings are listed; `moreWarnings` counts the rest. */
export const MAX_WARNINGS = 50;

export type ImportResult = {
  /** Top-level pages and databases created (under the destination), or the database merged into. */
  pages: { id: string; title: string; kind: "page" | "database" }[];
  /** Everything created: pages, databases, database rows, templates (workspace and row) and uploads. */
  created: { pages: number; databases: number; rows: number; templates: number; files: number };
  warnings: ImportWarning[];
  moreWarnings: number;
};

/** Collects warnings up to MAX_WARNINGS, counting the rest. */
export class WarningList {
  readonly list: ImportWarning[] = [];
  more = 0;
  add(warning: ImportWarning) {
    if (this.list.length < MAX_WARNINGS) this.list.push(warning);
    else this.more++;
  }
}

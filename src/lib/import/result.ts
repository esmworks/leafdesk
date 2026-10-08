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
  /** Merging: no column goes to a property, or two go to the same one. */
  "badMapping",
  /** The destination is missing, in the trash or not editable, or not a database when merging. */
  "noAccess",
  "notADatabase",
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
  /** A relative link or image pointing at a file the upload doesn't have: left as it was. */
  | { code: "missingFile"; path: string; page: string }
  /** A file a page shows couldn't be stored (too large, quota): the link was left as it was. */
  | { code: "fileNotStored"; path: string; reason: "tooLarge" | "quotaExceeded" | "failed" }
  /**
   * Files left out: a ZIP inside the ZIP, a database inside a database, a duplicate CSV (or a
   * database's own Markdown file), a Markdown file over the size limit, a file no page shows or
   * links to (there's nowhere to put it), a ZIP entry whose path climbs out of the archive, and
   * the sheets of a workbook other than the one imported (`path` is the sheet's name).
   */
  | { code: "skipped"; path: string; reason: "nestedZip" | "nestedDatabase" | "duplicate" | "tooLarge" | "unused" | "unsafePath" | "otherSheet" };

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

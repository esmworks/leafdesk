/**
 * Fired on `window` when someone turns a workbook a page shows into a database, with the workbook
 * as `detail.file` and that page as `detail.pageId`, so the sidebar opens the import dialog with
 * the workbook chosen, to go under that page.
 */
export const IMPORT_SPREADSHEET_EVENT = "leafdesk:import-spreadsheet";

export type ImportSpreadsheetDetail = { file: File; pageId: string };

/**
 * Fired on `window` when someone turns a workbook a page shows into a database, with the workbook
 * as `detail.file`, so the sidebar opens the import dialog with it chosen.
 */
export const IMPORT_SPREADSHEET_EVENT = "leafdesk:import-spreadsheet";

export type ImportSpreadsheetDetail = { file: File };

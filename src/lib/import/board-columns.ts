/**
 * What a column of an Asana or Monday.com export can become; the import dialog offers these (or
 * leaving the column out). Kept apart from `board.ts` so the dialog can show them without loading
 * the export readers until a file is chosen.
 */
export const BOARD_COLUMN_TYPES = ["text", "number", "select", "multi_select", "status", "person", "date", "checkbox", "url", "email", "phone", "place"] as const;
export type BoardColumnType = (typeof BOARD_COLUMN_TYPES)[number];

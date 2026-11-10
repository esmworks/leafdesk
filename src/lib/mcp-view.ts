import type { NumberFormat } from "@/db/schema/app";

/**
 * What MCP's show_database hands the view that draws it (an MCP App, see
 * server/mcp/app-view.ts): a database's rows as query_database returns them, plus how each column
 * shows (mcp-view-columns.ts). Types and constants only, so the view's bundle (src/mcp-app/) takes
 * nothing else in with them.
 */

/** The address of the view that draws show_database's result. */
export const DATABASE_VIEW_URI = "ui://leafdesk/database-view.html";

/**
 * How a column's values show: text; numbers in the property's format; dates; a checkbox; option
 * chips in their colors; names of related rows, people or files; a checklist's ticked share.
 */
export type ViewColumnKind = "text" | "number" | "date" | "checkbox" | "options" | "names" | "checklist";

export type ViewColumn = {
  /** The property's name: rows hold their values by it. */
  name: string;
  kind: ViewColumnKind;
  /** Numbers: how they show (number-format.ts). */
  format?: NumberFormat;
  /** Options: each option's color, by its name. */
  colors?: Record<string, string>;
};

/** The arguments a page of rows was asked with, so the view can ask for the next one. */
export type ViewRequest = {
  database_id: string;
  view_id?: string;
  filters?: unknown;
  filter_combinator?: "and" | "or";
  sorts?: unknown;
  properties?: string[];
  include_archived?: boolean;
  limit: number;
};

export type DatabaseViewData = {
  database: { id: string; title: string; url: string };
  view: { id: string; name: string } | null;
  columns: ViewColumn[];
  rows: { id: string; title: string; url: string; properties: Record<string, unknown> }[];
  total: number;
  next_cursor: string | null;
  request: ViewRequest;
  note: string;
};

/** The view's words, in the reader's language; `showing` holds SHOWN and TOTAL where the counts go. */
export type ViewTexts = {
  name: string;
  open: string;
  more: string;
  showing: string;
  empty: string;
  failed: string;
  unavailable: string;
  checked: string;
  unchecked: string;
  loading: string;
};

/** What the server writes into the view's page: the reader's language and the words in it. */
export type ViewSetup = { locale: string; texts: ViewTexts };

/** Stand-ins for the counts in `showing`, which only the view knows as it reads on. */
export const SHOWN = "\u0001shown\u0001";
export const TOTAL = "\u0001total\u0001";

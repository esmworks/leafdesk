/**
 * Shared types of the formula language. Client-safe and dependency free: the same code checks and
 * evaluates formulas in the browser (live editor, optimistic edits) and on the server (every read).
 */

/**
 * What an expression evaluates to. The list types only exist inside formulas (a list result is
 * stored as text): `list` holds texts, `numbers` numbers, `rows` the rows a relation links to;
 * `row` is one of those rows (empty: null).
 */
export type FormulaType = "number" | "text" | "checkbox" | "date" | "list" | "numbers" | "rows" | "row";

/** Types that are lists: every function taking a list of texts takes the others too, as texts. */
export const LIST_TYPES: readonly FormulaType[] = ["list", "numbers", "rows"];

/** A result type a formula property can have (lists and rows are stored as text). */
export type FormulaResultType = "number" | "text" | "checkbox" | "date";

/**
 * Dates are instants in milliseconds (UTC); `time` is false for calendar days (stored as YYYY-MM-DD).
 * A date property's range also has its `end` (the last day, or the end time); everything but
 * `dateEnd()` works on the start.
 */
export type DateValue = { date: number; time: boolean; end?: number };

/**
 * A related row: which database it is in (to read its properties), and its title. `beyond`: past
 * the first MAX_RELATED_ROWS rows of its relation, so its properties can't be read.
 */
export type RowRef = { rowId: string; databaseId: string; title: string; beyond?: true };

/** A piece of styled text: what `+` and concat() make of styled values. */
export type StyledPart = { text: string; styles: string[] };

/** A value with styles (see style()): the whole value, or text put together from styled parts. */
export type StyledValue = { kind: "styled"; value: PlainValue; styles: string[] } | { kind: "parts"; parts: StyledPart[] };

/**
 * A value without styles. Only numbers, dates and rows can be empty (null): empty text reads as
 * "", empty lists as [] and unticked checkboxes as false.
 */
export type PlainValue = number | string | boolean | DateValue | RowRef | string[] | number[] | RowRef[] | null;

/** A value while evaluating. */
export type Value = PlainValue | StyledValue;

/**
 * How a formula's result shows (the value itself is stored without it, so sorts, filters and
 * exports read the plain value): styles on the whole value, or on parts of a text.
 */
export type FormulaStyle = { styles: string[] } | { parts: StyledPart[] };

export const FORMULA_ERROR_CODES = [
  // Found while parsing or type checking: the formula can't run on any row.
  "syntax",
  "unexpectedEnd",
  "unterminatedString",
  "unknownFunction",
  "unknownProperty",
  "propArgument",
  "argumentCount",
  "ifsArguments",
  "argumentType",
  "operatorType",
  "unaryType",
  "branchTypes",
  "cycle",
  "referenceError",
  "tooLong",
  "tooDeep",
  "invalidUnit",
  "invalidStyle",
  "currentOutside",
  "relatedDepth",
  // Found while evaluating one row.
  "divisionByZero",
  "notANumber",
  "invalidDate",
  "notFinite",
  "resultTooLong",
  "relatedLimit",
  // Rollups whose settings no longer work (see lib/rollup), shown in every row like a broken formula.
  "rollupRelation",
  "rollupTarget",
  "rollupFunction",
  "rollupDepth",
] as const;
export type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number];

/**
 * A formula problem. `message` is English (MCP clients read it); the UI translates by `code` with
 * `params` (see `database.formula.errors.*`). `start`/`end` locate compile errors in the source.
 */
export type FormulaError = {
  code: FormulaErrorCode;
  message: string;
  params: Record<string, string>;
  start?: number;
  end?: number;
};

export class FormulaFailure extends Error {
  readonly error: FormulaError;
  constructor(error: FormulaError) {
    super(error.message);
    this.name = "FormulaFailure";
    this.error = error;
  }
}

export function fail(
  code: FormulaErrorCode,
  message: string,
  params: Record<string, string | number> = {},
  at?: { start: number; end: number },
): never {
  const stringParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  throw new FormulaFailure({ code, message, params: stringParams, ...(at ? { start: at.start, end: at.end } : {}) });
}

/** Longest expression accepted (characters). */
export const MAX_FORMULA_LENGTH = 4000;
/** Deepest nesting of parentheses, calls and operators. */
export const MAX_FORMULA_DEPTH = 64;
/** Longest text a formula may produce. */
export const MAX_TEXT_LENGTH = 10_000;
/** Most related rows of one relation a formula reads the properties of, per row. */
export const MAX_RELATED_ROWS = 200;

/**
 * Thrown when a formula reads a value the viewer may not see (a property of a related row that
 * property access keeps from them): the formula then shows nothing for that row, like a formula
 * over a hidden property of its own row. Not a FormulaFailure, so no error tells anything either.
 */
export class HiddenValue extends Error {
  constructor() {
    super("hidden");
    this.name = "HiddenValue";
  }
}

/** English name of a type, for messages ("text or list"). */
export function typeNames(types: readonly FormulaType[]) {
  return types.join(" or ");
}

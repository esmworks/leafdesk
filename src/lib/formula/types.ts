/**
 * Shared types of the formula language. Client-safe and dependency free: the same code checks and
 * evaluates formulas in the browser (live editor, optimistic edits) and on the server (every read).
 */

/** What an expression evaluates to. `list` only exists inside formulas; a list result is stored as text. */
export type FormulaType = "number" | "text" | "checkbox" | "date" | "list";

/** A result type a formula property can have (lists are joined into text). */
export type FormulaResultType = Exclude<FormulaType, "list">;

/**
 * Dates are instants in milliseconds (UTC); `time` is false for calendar days (stored as YYYY-MM-DD).
 * A date property's range also has its `end` (the last day, or the end time); everything but
 * `dateEnd()` works on the start.
 */
export type DateValue = { date: number; time: boolean; end?: number };

/**
 * A value while evaluating. Only numbers and dates can be empty (null): empty text reads as "",
 * empty lists as [] and unticked checkboxes as false.
 */
export type Value = number | string | boolean | DateValue | string[] | null;

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
  // Found while evaluating one row.
  "divisionByZero",
  "notANumber",
  "invalidDate",
  "notFinite",
  "resultTooLong",
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

/** English name of a type, for messages ("text or list"). */
export function typeNames(types: readonly FormulaType[]) {
  return types.join(" or ");
}

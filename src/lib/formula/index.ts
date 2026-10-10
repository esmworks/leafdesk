import { storeDate } from "./dates";
import {
  check,
  emptyNotes,
  evaluate,
  formatValue,
  isRow,
  isStyled,
  plain,
  type CheckNotes,
  type EvalEnv,
  type FieldResolver,
  type RelatedResolver,
} from "./engine";
import { quote, tokenize } from "./lexer";
import { parse, references, relatedReads, type Node, type PropNode } from "./parser";
import {
  fail,
  FormulaFailure,
  LIST_TYPES,
  type FormulaError,
  type FormulaResultType,
  type FormulaStyle,
  type FormulaType,
  type Value,
} from "./types";

/**
 * The formula language: `prop("Name")` references, `prop(row, "Name")` on related rows, literals,
 * operators and functions (see engine.ts). Pure and client-safe; `lib/derived` applies it to
 * database properties and rows.
 */

export { DATE_UNITS } from "./dates";
export {
  emptyNotes,
  FORMULA_FUNCTIONS,
  formatValue,
  isEmptyValue,
  type CheckNotes,
  type EvalEnv,
  type Field,
  type FieldResolver,
  type FormulaFunctionGroup,
  type RelatedResolver,
} from "./engine";
export { toDateValue } from "./dates";
export { asFormulaStyle, STYLE_COLORS, STYLE_NAMES, styleClasses, TEXT_STYLES } from "./styles";
export * from "./types";
export { relatedReads, type Node, type PropNode } from "./parser";

/** `related`: whether the formula reads properties of related rows (`prop(row, "…")`). */
export type ParsedFormula = { ast: Node | null; refs: string[]; related: boolean; error: FormulaError | null };

// Rows are evaluated many times per expression; parsing once per distinct expression is enough.
const parsed = new Map<string, ParsedFormula>();
const MAX_CACHED = 500;

function asError(error: unknown): FormulaError {
  if (error instanceof FormulaFailure) return error.error;
  throw error;
}

/** Parses an expression (cached). Empty expressions parse to a null tree. */
export function parseFormula(expression: string): ParsedFormula {
  const hit = parsed.get(expression);
  if (hit) return hit;
  let result: ParsedFormula;
  try {
    const ast = parse(expression);
    result = { ast, refs: references(ast), related: relatedReads(ast).length > 0, error: null };
  } catch (error) {
    result = { ast: null, refs: [], related: false, error: asError(error) };
  }
  if (parsed.size >= MAX_CACHED) parsed.delete(parsed.keys().next().value!);
  parsed.set(expression, result);
  return result;
}

/**
 * The type a parsed formula produces with these fields, or the first error. An empty formula is
 * empty text. A list result is stored as text (items joined with ", "), and so is a row (its
 * title). `related` resolves properties of related rows; `notes` is what evaluation needs.
 */
export function checkFormula(
  formula: ParsedFormula,
  fields: FieldResolver,
  related?: RelatedResolver,
): { type: FormulaResultType; error: FormulaError | null; notes: CheckNotes } {
  const notes = emptyNotes();
  if (formula.error) return { type: "text", error: formula.error, notes };
  if (!formula.ast) return { type: "text", error: null, notes };
  try {
    const type = check(formula.ast, fields, related, notes);
    return { type: resultType(type), error: null, notes };
  } catch (error) {
    return { type: "text", error: asError(error), notes };
  }
}

/** What a formula of this type stores: lists and rows as text. */
export function resultType(type: FormulaType): FormulaResultType {
  return LIST_TYPES.includes(type) || type === "row" ? "text" : (type as FormulaResultType);
}

/**
 * Evaluates a checked formula on one row and returns the value to store: a number, text, boolean,
 * or a date as YYYY-MM-DD / ISO timestamp; null when empty. Styles are not stored with it: `style`
 * says how it shows. Throws a FormulaFailure when the row can't be evaluated, and HiddenValue when
 * it reads a value the viewer may not see.
 */
export function runFormula(ast: Node | null, env: EvalEnv): { raw: Value; stored: unknown; style: FormulaStyle | null } {
  if (!ast) return { raw: "", stored: null, style: null };
  const raw = evaluate(ast, env);
  return { raw, stored: storedValue(raw), style: styleOf(raw) };
}

export function storedValue(value: Value): unknown {
  const raw = plain(value);
  if (raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) fail("notFinite", "The result is not a finite number");
    return raw;
  }
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "" ? null : raw;
  if (Array.isArray(raw)) return raw.length ? formatValue(raw) : null;
  if (isRow(raw)) return raw.title || null;
  return storeDate(raw);
}

/** How a result shows: null without styles, or when it is empty (nothing to style). */
export function styleOf(value: Value): FormulaStyle | null {
  if (!isStyled(value) || storedValue(value) === null) return null;
  if (value.kind === "parts") return { parts: value.parts };
  return value.styles.length ? { styles: value.styles } : null;
}

/** A formula's own list and row values read as text by other formulas (they are stored as text). */
export function fieldType(type: FormulaType): FormulaType {
  return resultType(type);
}

/** A formula's raw result as another formula of the row reads it: lists and rows as their text. */
export function asFieldValue(raw: Value): Value {
  const p = plain(raw);
  if (!Array.isArray(p) && !isRow(p)) return raw;
  const text = formatValue(p);
  return isStyled(raw) && raw.kind === "styled" ? { kind: "styled", value: text, styles: raw.styles } : text;
}

/**
 * Rewrites the key of every `prop("…")` in an expression; `map` returns the new key, or null to
 * keep it. The rest of the text stays exactly as typed. Text after a spot the tokenizer can't read
 * (an unclosed quote while typing) is kept unchanged.
 */
export function rewriteReferences(expression: string, map: (key: string) => string | null): string {
  const tokens = tokenize(expression, { tolerant: true });
  let out = "";
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const [name, open, arg, close] = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if (
      name?.kind === "name" &&
      name.value.toLowerCase() === "prop" &&
      open?.kind === "punct" &&
      open.value === "(" &&
      arg?.kind === "string" &&
      close?.kind === "punct" &&
      close.value === ")"
    ) {
      const next = map(arg.value);
      if (next !== null && next !== arg.value) {
        out += expression.slice(last, arg.start) + quote(next);
        last = arg.end;
      }
    }
  }
  return out + expression.slice(last);
}

/**
 * Rewrites the key of every `prop(row, "…")` (a related row's property); `map` returns the new key,
 * or null to keep it. Only for expressions that parse: until then they stay as typed.
 */
export function rewriteRelatedReferences(expression: string, map: (node: PropNode) => string | null): string {
  const { ast } = parseFormula(expression);
  const reads = relatedReads(ast).sort((a, b) => a.keyAt.start - b.keyAt.start);
  let out = "";
  let last = 0;
  for (const node of reads) {
    const next = map(node);
    if (next === null || next === node.key) continue;
    out += expression.slice(last, node.keyAt.start) + quote(next);
    last = node.keyAt.end;
  }
  return out + expression.slice(last);
}

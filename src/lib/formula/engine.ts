import * as dates from "./dates";
import type { BinaryOp, Node } from "./parser";
import { addStyles, mergeParts, requireStyle } from "./styles";
import {
  fail,
  FormulaFailure,
  HiddenValue,
  LIST_TYPES,
  MAX_RELATED_ROWS,
  MAX_TEXT_LENGTH,
  typeNames,
  type DateValue,
  type FormulaType,
  type PlainValue,
  type RowRef,
  type StyledPart,
  type StyledValue,
  type Value,
} from "./types";

/**
 * Type checking and evaluation of a parsed formula. Checking runs once per formula and decides the
 * result type (or a compile error); evaluation runs once per row and may still fail on that row
 * (division by zero, an unreadable date…). Both throw FormulaFailure.
 */

/**
 * A property a formula can read: its current name (for messages) and type; null type = it has an
 * error. `database`: for a relation read as rows, the database its rows are in. `relatedReads`: a
 * formula that reads related rows itself, which a formula of another database can't read (one step
 * away at most).
 */
export type Field = { id?: string; name: string; type: FormulaType | null; database?: string; relatedReads?: boolean };
export type FieldResolver = (key: string) => Field | undefined;
/** The properties of related rows: `key` in the database `databaseId`. */
export type RelatedResolver = (databaseId: string, key: string) => Field | undefined;

/**
 * What checking found out that evaluation needs: calls whose lists are read as texts (branches
 * mixing kinds of lists), and the type of nodes that can come out empty without a value telling
 * which kind of empty (a property of no row, the first item of no list). `reads` lists every
 * `prop(row, "…")` with the related database and property it reads.
 */
export type CheckNotes = {
  asTexts: Set<Node>;
  types: Map<Node, FormulaType>;
  reads: Map<Node, { database: string; field: Field }>;
};

export const emptyNotes = (): CheckNotes => ({ asTexts: new Set(), types: new Map(), reads: new Map() });

export type EvalEnv = {
  /** The value of `prop(key)` on the row being evaluated; throws for a referenced formula's error. */
  value: (key: string) => Value;
  now: Date;
  /**
   * The value of `prop(row, key)`: a property of a related row. Throws HiddenValue when the
   * viewer may not see it. Without it every related value is hidden.
   */
  related?: (row: RowRef, key: string) => Value;
  /** From checking (see CheckNotes). */
  notes?: CheckNotes;
  /** The item `current` stands for, inside map(), filter() and the like. */
  current?: { value: PlainValue };
};

type ArgType = FormulaType | "any";
type Group = "logic" | "text" | "number" | "date" | "list" | "style" | "conversion";

type FnSpec = {
  group: Group;
  /** Shown in the editor's function list. */
  signature: string;
  min: number;
  max: number;
  /** Returns the result type for these argument types, or throws. */
  check: (types: FormulaType[], args: Node[], name: string) => FormulaType;
  /** Eager functions get their evaluated arguments (plain unless `styled`); lazy ones evaluate their own. */
  run?: (values: Value[], env: EvalEnv, node: Node) => Value;
  lazy?: (args: Node[], env: EvalEnv, node: Node) => Value;
  /** Arguments keep their styles (style(), unstyle(), concat()). */
  styled?: boolean;
  /** The second argument is checked and evaluated once per item of the first, as `current`. */
  perItem?: boolean;
  /** Which arguments are results (if, ifs): row results must come from one database. */
  branches?: (count: number) => number[];
  /** The argument a row result comes from, when not the first one with rows (map). */
  rowsFrom?: number;
};

const isListType = (t: FormulaType) => LIST_TYPES.includes(t);

function argType(name: string, index: number, actual: FormulaType, allowed: readonly ArgType[]) {
  if (allowed.includes("any") || allowed.includes(actual)) return;
  // Numbers and rows read as texts wherever a list of texts goes (a relation as its titles).
  if (allowed.includes("list") && isListType(actual)) return;
  fail(
    "argumentType",
    `${name}() expects ${typeNames(allowed as FormulaType[])} as argument ${index + 1}, not ${actual}`,
    { name, index: index + 1, expected: allowed.join("|"), actual },
  );
}

/** A function whose argument types are fixed per position (the last entry repeats for variadic ones). */
function fixed(
  group: Group,
  signature: string,
  params: readonly (readonly ArgType[])[],
  returns: FormulaType | ((types: FormulaType[]) => FormulaType),
  run: (values: Value[], env: EvalEnv, node: Node) => Value,
  { min = params.length, max = params.length }: { min?: number; max?: number } = {},
): FnSpec {
  return {
    group,
    signature,
    min,
    max,
    check: (types, _args, name) => {
      types.forEach((t, i) => argType(name, i, t, params[Math.min(i, params.length - 1)]));
      return typeof returns === "function" ? returns(types) : returns;
    },
    run,
  };
}

const NUM = ["number"] as const;
const TEXT = ["text"] as const;
const DATE = ["date"] as const;
const BOOL = ["checkbox"] as const;
const ANY = ["any"] as const;
const LISTS = ["list", "numbers", "rows"] as const;

export const isStyled = (v: Value): v is StyledValue => typeof v === "object" && v !== null && !Array.isArray(v) && "kind" in v;
export const isRow = (v: Value): v is RowRef => typeof v === "object" && v !== null && !Array.isArray(v) && "rowId" in v;
const isDate = (v: Value): v is DateValue =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as DateValue).date === "number";

/** A value without its styles. */
export function plain(v: Value): PlainValue {
  if (!isStyled(v)) return v;
  return v.kind === "styled" ? v.value : v.parts.map((p) => p.text).join("");
}

const asText = (v: Value) => (typeof v === "string" ? v : "");
const asNum = (v: Value) => (typeof v === "number" ? v : null);
/** A list's items as they are (texts, numbers or rows); [] for anything else. */
const items = (v: Value): (string | number | RowRef)[] => (Array.isArray(v) ? v : []);
/** A list's items as texts: numbers formatted, rows by title. */
const textItems = (v: Value): string[] => items(v).map((item) => formatValue(item));

function limitText(text: string) {
  if (text.length > MAX_TEXT_LENGTH) {
    fail("resultTooLong", `The text is longer than ${MAX_TEXT_LENGTH} characters`, { max: MAX_TEXT_LENGTH });
  }
  return text;
}

/** Numbers as text without floating point noise (0.1 + 0.2 is "0.3"). */
export function formatNumber(n: number) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

/** Any value as text: what format() and text concatenation produce. Rows read as their titles. */
export function formatValue(v: Value): string {
  if (isStyled(v)) return formatValue(plain(v));
  if (v === null) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((item) => formatValue(item)).join(", ");
  if (isRow(v)) return v.title;
  return dates.formatDate(v);
}

/** Whether a value is empty: no value, "", no items, unchecked, or 0. */
export function isEmptyValue(v: Value) {
  const p = plain(v);
  return p === null || p === "" || p === false || p === 0 || (Array.isArray(p) && p.length === 0);
}

/** The empty value of a type (what a property of no row reads as). */
function emptyOf(type: FormulaType | undefined): PlainValue {
  if (type === "text") return "";
  if (type === "checkbox") return false;
  if (type && isListType(type)) return [];
  return null;
}

/**
 * Text put together from values, each keeping its styles: plain text when none has any, else the
 * styled parts (neighbours with the same styles joined).
 */
function joinStyled(values: Value[]): Value {
  if (!values.some(isStyled)) return limitText(values.map(formatValue).join(""));
  const parts = mergeParts(
    values.flatMap((v): StyledPart[] =>
      isStyled(v) ? (v.kind === "parts" ? v.parts : [{ text: formatValue(v.value), styles: v.styles }]) : [{ text: formatValue(v), styles: [] }],
    ),
  );
  limitText(parts.map((p) => p.text).join(""));
  if (parts.every((p) => !p.styles.length)) return parts.map((p) => p.text).join("");
  if (parts.length === 1) return { kind: "styled", value: parts[0].text, styles: parts[0].styles };
  return { kind: "parts", parts };
}

function withStyles(v: Value, names: string[]): Value {
  if (!names.length) return v;
  if (isStyled(v)) {
    if (v.kind === "styled") return { ...v, styles: addStyles(v.styles, names) };
    return { kind: "parts", parts: v.parts.map((p) => ({ ...p, styles: addStyles(p.styles, names) })) };
  }
  return { kind: "styled", value: v, styles: addStyles([], names) };
}

function withoutStyles(v: Value, names: string[]): Value {
  if (!isStyled(v) || !names.length) return plain(v);
  if (v.kind === "styled") {
    const styles = v.styles.filter((s) => !names.includes(s));
    return styles.length ? { ...v, styles } : v.value;
  }
  return joinStyled(v.parts.map((p) => ({ kind: "styled", value: p.text, styles: p.styles.filter((s) => !names.includes(s)) })));
}

function round(n: number, digits: number) {
  const d = Math.trunc(digits);
  if (!d) return Math.round(n);
  // Shifting through the exponent avoids 1.005 * 100 = 100.49999…
  const shifted = Math.round(Number(`${n}e${d}`));
  return Number(`${shifted}e${-d}`);
}

function toNumber(v: Value): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.date;
  const text = formatValue(v).trim();
  if (!text) return null;
  const n = Number(text.replace(",", "."));
  if (!Number.isFinite(n)) fail("notANumber", `"${text}" is not a number`, { value: text });
  return n;
}

/** Checks the unit when it is written out, so a typo shows while editing instead of on every row. */
function unitLiteral(args: Node[], index: number) {
  const node = args[index];
  if (node?.kind === "string") dates.requireUnit(node.value);
}

const dateArithmetic = (sign: 1 | -1, signature: string): FnSpec => ({
  group: "date",
  signature,
  min: 3,
  max: 3,
  check: (types, args, name) => {
    [DATE, NUM, TEXT].forEach((allowed, i) => argType(name, i, types[i], allowed));
    unitLiteral(args, 2);
    return "date";
  },
  run: ([date, amount, unit]) => {
    const u = dates.requireUnit(asText(unit));
    if (!isDate(date)) return null;
    return dates.dateAdd(date, sign * (asNum(amount) ?? 0), u);
  },
});

const datePart = (part: dates.DatePart): FnSpec =>
  fixed("date", `${part}(date)`, [DATE], "number", ([d]) => (isDate(d) ? dates.datePart(d, part) : null));

const mathFn = (signature: string, fn: (n: number) => number): FnSpec =>
  fixed("number", signature, [NUM], "number", ([n]) => (typeof n === "number" ? fn(n) : null));

/** Numbers of the arguments, lists of numbers spread out. */
const numbersOf = (values: Value[]) => values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is number => typeof v === "number");

const NUMBERS = ["number", "numbers"] as const;

const extreme = (signature: string, pick: (...n: number[]) => number): FnSpec =>
  fixed(
    "number",
    signature,
    [NUMBERS],
    "number",
    (values) => {
      const nums = numbersOf(values);
      return nums.length ? pick(...nums) : null;
    },
    { min: 1, max: Infinity },
  );

/** The type of a list's items. */
function itemType(list: FormulaType): FormulaType {
  return list === "numbers" ? "number" : list === "rows" ? "row" : "text";
}

function sameTypes(name: string, types: FormulaType[]) {
  const [first, ...rest] = types;
  // Lists of different kinds come out as texts (a relation and a multi-select: titles and names).
  if (types.every(isListType)) return types.every((t) => t === first) ? first : "list";
  const other = rest.find((t) => t !== first);
  if (other) {
    fail("branchTypes", `${name}() needs every result to have the same type, not ${first} and ${other}`, {
      name,
      left: first,
      right: other,
    });
  }
  return first;
}

/** Every function, by lowercase name. No prototype, so a name like "constructor" is unknown too. */
const FUNCTIONS: Record<string, FnSpec & { name: string }> = Object.create(null);
const define = (name: string, spec: FnSpec) => {
  FUNCTIONS[name.toLowerCase()] = { ...spec, name };
};

const truthy = (node: Node, env: EvalEnv) => plain(evaluate(node, env)) === true;

// Logic
define("if", {
  group: "logic",
  signature: "if(condition, then, else)",
  min: 3,
  max: 3,
  check: (types, _args, name) => {
    argType(name, 0, types[0], BOOL);
    return sameTypes(name, [types[1], types[2]]);
  },
  lazy: ([cond, then, otherwise], env) => (truthy(cond, env) ? evaluate(then, env) : evaluate(otherwise, env)),
  branches: () => [1, 2],
});
define("ifs", {
  group: "logic",
  signature: "ifs(condition, value, …, else)",
  min: 3,
  max: Infinity,
  check: (types, _args, name) => {
    if (types.length % 2 === 0) {
      fail("ifsArguments", `${name}() takes condition/value pairs and a final else value`, { name });
    }
    const results: FormulaType[] = [];
    for (let i = 0; i < types.length - 1; i += 2) {
      argType(name, i, types[i], BOOL);
      results.push(types[i + 1]);
    }
    results.push(types[types.length - 1]);
    return sameTypes(name, results);
  },
  lazy: (args, env) => {
    for (let i = 0; i < args.length - 1; i += 2) if (truthy(args[i], env)) return evaluate(args[i + 1], env);
    return evaluate(args[args.length - 1], env);
  },
  branches: (count) => [...Array.from({ length: (count - 1) / 2 }, (_, i) => i * 2 + 1), count - 1],
});
define("and", {
  ...fixed("logic", "and(a, b, …)", [BOOL], "checkbox", () => null, { min: 1, max: Infinity }),
  run: undefined,
  lazy: (args, env) => args.every((a) => truthy(a, env)),
});
define("or", {
  ...fixed("logic", "or(a, b, …)", [BOOL], "checkbox", () => null, { min: 1, max: Infinity }),
  run: undefined,
  lazy: (args, env) => args.some((a) => truthy(a, env)),
});
define("not", fixed("logic", "not(value)", [BOOL], "checkbox", ([v]) => v !== true));
define("empty", fixed("logic", "empty(value)", [ANY], "checkbox", ([v]) => isEmptyValue(v)));

// Text
define("concat", {
  ...fixed("text", "concat(a, b, …)", [ANY], "text", (values) => joinStyled(values), { min: 1, max: Infinity }),
  styled: true,
});
define(
  "length",
  fixed("text", "length(text or list)", [["text", "list"]], "number", ([v]) => (Array.isArray(v) ? v.length : asText(v).length)),
);
define("lower", fixed("text", "lower(text)", [TEXT], "text", ([v]) => asText(v).toLowerCase()));
define("upper", fixed("text", "upper(text)", [TEXT], "text", ([v]) => asText(v).toUpperCase()));
define("trim", fixed("text", "trim(text)", [TEXT], "text", ([v]) => asText(v).trim()));
define(
  "contains",
  fixed("text", "contains(text or list, text)", [["text", "list"], TEXT], "checkbox", ([v, part]) =>
    Array.isArray(v) ? textItems(v).includes(asText(part)) : asText(v).includes(asText(part)),
  ),
);
define("startsWith", fixed("text", "startsWith(text, text)", [TEXT, TEXT], "checkbox", ([v, p]) => asText(v).startsWith(asText(p))));
define("endsWith", fixed("text", "endsWith(text, text)", [TEXT, TEXT], "checkbox", ([v, p]) => asText(v).endsWith(asText(p))));
define(
  "replace",
  fixed("text", "replace(text, find, replacement)", [TEXT, TEXT, TEXT], "text", ([v, find, by]) =>
    limitText(asText(find) ? asText(v).replace(asText(find), () => asText(by)) : asText(v)),
  ),
);
define(
  "replaceAll",
  fixed("text", "replaceAll(text, find, replacement)", [TEXT, TEXT, TEXT], "text", ([v, find, by]) =>
    limitText(asText(find) ? asText(v).split(asText(find)).join(asText(by)) : asText(v)),
  ),
);
define(
  "slice",
  fixed(
    "text",
    "slice(text, start, end)",
    [TEXT, NUM, NUM],
    "text",
    ([v, start, end]) => asText(v).slice(Math.trunc(asNum(start) ?? 0), end === undefined || end === null ? undefined : Math.trunc(end as number)),
    { min: 2, max: 3 },
  ),
);
define("join", fixed("text", "join(list, separator)", [["list"], TEXT], "text", ([v, sep]) => limitText(textItems(v).join(asText(sep)))));
define("format", fixed("conversion", "format(value)", [ANY], "text", ([v]) => limitText(formatValue(v))));

// Styles: the type stays the value's, so sorts and filters read it as before.
/** Checks style names written out, so a typo shows while editing. */
function styleLiterals(args: Node[]) {
  for (const node of args.slice(1)) if (node.kind === "string") requireStyle(node.value);
}
const styleNames = (values: Value[]) => values.slice(1).map((v) => requireStyle(asText(plain(v))));
define("style", {
  group: "style",
  signature: "style(value, style, …)",
  min: 2,
  max: Infinity,
  check: (types, args, name) => {
    types.slice(1).forEach((t, i) => argType(name, i + 1, t, TEXT));
    styleLiterals(args);
    return types[0];
  },
  run: (values) => withStyles(values[0], styleNames(values)),
  styled: true,
});
define("unstyle", {
  group: "style",
  signature: "unstyle(value, style, …)",
  min: 1,
  max: Infinity,
  check: (types, args, name) => {
    types.slice(1).forEach((t, i) => argType(name, i + 1, t, TEXT));
    styleLiterals(args);
    return types[0];
  },
  run: (values) => withoutStyles(values[0], styleNames(values)),
  styled: true,
});

// Lists: map(), filter() and the like look at each item as `current`.
const perItem = (
  signature: string,
  returns: (list: FormulaType, each: FormulaType, name: string) => FormulaType,
  run: (list: (string | number | RowRef)[], each: (item: PlainValue) => PlainValue, node: Node, env: EvalEnv) => Value,
): FnSpec => ({
  group: "list",
  signature,
  min: 2,
  max: 2,
  perItem: true,
  check: (types, _args, name) => {
    argType(name, 0, types[0], LISTS);
    return returns(types[0], types[1], name);
  },
  lazy: ([list, expression], env, node) => {
    const each = (item: PlainValue) => plain(evaluate(expression, { ...env, current: { value: item } }));
    return run(items(plain(evaluate(list, env))), each, node, env);
  },
});
const condition = (name: string, each: FormulaType) => argType(name, 1, each, BOOL);

define(
  "map",
  {
    ...perItem(
      "map(list, expression)",
      (_list, each, name) => {
        if (isListType(each)) argType(name, 1, each, ["number", "text", "checkbox", "date", "row"]);
        return each === "number" ? "numbers" : each === "row" ? "rows" : "list";
      },
      (list, each) => {
        const out: (string | number | RowRef)[] = [];
        for (const item of list) {
          const v = each(item);
          // Empty numbers and rows aren't items; other values are listed as texts.
          if (v === null) continue;
          out.push(typeof v === "number" || isRow(v) ? v : formatValue(v));
        }
        return out as PlainValue;
      },
    ),
    rowsFrom: 1,
  },
);
define(
  "filter",
  perItem(
    "filter(list, condition)",
    (list, each, name) => (condition(name, each), list),
    (list, each) => list.filter((item) => each(item) === true) as PlainValue,
  ),
);
define(
  "find",
  perItem(
    "find(list, condition)",
    (list, each, name) => (condition(name, each), itemType(list)),
    (list, each, node, env) => list.find((item) => each(item) === true) ?? emptyOf(env.notes?.types.get(node)),
  ),
);
define(
  "some",
  perItem("some(list, condition)", (_l, each, name) => (condition(name, each), "checkbox"), (list, each) => list.some((item) => each(item) === true)),
);
define(
  "every",
  perItem("every(list, condition)", (_l, each, name) => (condition(name, each), "checkbox"), (list, each) => list.every((item) => each(item) === true)),
);
const pick = (signature: string, at: (list: (string | number | RowRef)[], values: Value[]) => string | number | RowRef | undefined, params: readonly (readonly ArgType[])[]) =>
  fixed("list", signature, params, (types) => itemType(types[0]), (values, env, node) => at(items(values[0]), values) ?? emptyOf(env.notes?.types.get(node)));
define("first", pick("first(list)", (list) => list[0], [LISTS]));
define("last", pick("last(list)", (list) => list[list.length - 1], [LISTS]));
define("at", pick("at(list, index)", (list, [, index]) => list.at(Math.trunc(asNum(index) ?? 0)), [LISTS, NUM]));
define("sum", fixed("list", "sum(numbers)", [NUMBERS], "number", (values) => numbersOf(values).reduce((a, b) => a + b, 0), { min: 1, max: Infinity }));
define(
  "average",
  fixed(
    "list",
    "average(numbers)",
    [NUMBERS],
    "number",
    (values) => {
      const nums = numbersOf(values);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    },
    { min: 1, max: Infinity },
  ),
);

// Numbers
define(
  "round",
  fixed("number", "round(number, digits)", [NUM, NUM], "number", ([n, digits]) => (typeof n === "number" ? round(n, asNum(digits) ?? 0) : null), {
    min: 1,
    max: 2,
  }),
);
define("floor", mathFn("floor(number)", Math.floor));
define("ceil", mathFn("ceil(number)", Math.ceil));
define("abs", mathFn("abs(number)", Math.abs));
define("sqrt", mathFn("sqrt(number)", Math.sqrt));
define("sign", mathFn("sign(number)", Math.sign));
define(
  "pow",
  fixed("number", "pow(base, exponent)", [NUM, NUM], "number", ([a, b]) => (typeof a === "number" ? a ** (asNum(b) ?? 0) : null)),
);
define("min", extreme("min(a, b, …)", Math.min));
define("max", extreme("max(a, b, …)", Math.max));

// Conversion
define("toNumber", fixed("conversion", "toNumber(value)", [["text", "number", "checkbox", "date"]], "number", ([v]) => toNumber(v)));
define(
  "parseDate",
  fixed("conversion", "parseDate(text)", [TEXT], "date", ([v]) => (asText(v).trim() ? dates.parseDate(asText(v)) : null)),
);

// Dates
define("now", fixed("date", "now()", [], "date", (_v, env) => ({ date: env.now.getTime(), time: true })));
define("today", fixed("date", "today()", [], "date", (_v, env) => dates.today(env.now)));
define("dateAdd", dateArithmetic(1, "dateAdd(date, amount, unit)"));
define("dateSubtract", dateArithmetic(-1, "dateSubtract(date, amount, unit)"));
define("dateBetween", {
  group: "date",
  signature: "dateBetween(date, date, unit)",
  min: 3,
  max: 3,
  check: (types, args, name) => {
    [DATE, DATE, TEXT].forEach((allowed, i) => argType(name, i, types[i], allowed));
    unitLiteral(args, 2);
    return "number";
  },
  run: ([a, b, unit]) => {
    const u = dates.requireUnit(asText(unit));
    return isDate(a) && isDate(b) ? dates.dateBetween(a, b, u) : null;
  },
});
define(
  "formatDate",
  fixed("date", "formatDate(date, format)", [DATE, TEXT], "text", ([d, format]) =>
    isDate(d) ? dates.formatDate(d, format === undefined ? undefined : asText(format)) : "",
    { min: 1, max: 2 },
  ),
);
define("dateStart", fixed("date", "dateStart(date)", [DATE], "date", ([d]) => (isDate(d) ? dates.dateStart(d) : null)));
define("dateEnd", fixed("date", "dateEnd(date)", [DATE], "date", ([d]) => (isDate(d) ? dates.dateEnd(d) : null)));
define("year", datePart("year"));
define("month", datePart("month"));
define("day", datePart("day"));
define("weekday", datePart("weekday"));
define("hour", datePart("hour"));
define("minute", datePart("minute"));
define("timestamp", fixed("date", "timestamp(date)", [DATE], "number", ([d]) => (isDate(d) ? d.date : null)));

/** The functions for the editor's reference list, in groups. */
export const FORMULA_FUNCTIONS = Object.values(FUNCTIONS).map(({ name, group, signature }) => ({ name, group, signature }));
export type FormulaFunctionGroup = Group;

// ---------------------------------------------------------------------------------------------

const ARITHMETIC = new Set<BinaryOp>(["-", "*", "/", "%", "^"]);
const ORDERING = new Set<BinaryOp>(["<", "<=", ">", ">="]);

function operatorError(op: string, left: FormulaType, right: FormulaType, at: Node): never {
  return fail("operatorType", `"${op}" can't be used with ${left} and ${right}`, { op, left, right }, at);
}

/** A checked type, with the database rows (and a row) come from. */
type Typed = { type: FormulaType; database?: string };
type CheckContext = { fields: FieldResolver; related?: RelatedResolver; notes: CheckNotes; scope: Typed[] };

/**
 * The type `node` evaluates to; throws a FormulaFailure (with the node's position) when it can't
 * run. `related` resolves properties of related rows (`prop(row, "…")`); `notes` collects what
 * evaluation needs (see CheckNotes).
 */
export function check(node: Node, fields: FieldResolver, related?: RelatedResolver, notes: CheckNotes = emptyNotes()): FormulaType {
  return typeOf(node, { fields, related, notes, scope: [] }).type;
}

function typeOf(node: Node, ctx: CheckContext): Typed {
  const at = { start: node.start, end: node.end };
  switch (node.kind) {
    case "number":
      return { type: "number" };
    case "string":
      return { type: "text" };
    case "boolean":
      return { type: "checkbox" };
    case "current": {
      const current = ctx.scope[ctx.scope.length - 1];
      if (!current) fail("currentOutside", '"current" can only be used inside map(), filter() and the like', {}, at);
      return current;
    }
    case "prop": {
      if (node.row) return relatedProp(node, ctx);
      const field = ctx.fields(node.key);
      if (!field) fail("unknownProperty", `Unknown property "${node.key}"`, { name: node.key }, at);
      if (!field.type) fail("referenceError", `"${field.name}" has an error`, { name: field.name }, at);
      return field.type === "rows" && field.database ? { type: "rows", database: field.database } : { type: field.type };
    }
    case "unary": {
      const t = typeOf(node.arg, ctx).type;
      const want = node.op === "-" ? "number" : "checkbox";
      if (t !== want) fail("unaryType", `"${node.op}" can't be used with ${t}`, { op: node.op, type: t }, at);
      return { type: want };
    }
    case "binary": {
      const l = typeOf(node.left, ctx).type;
      const r = typeOf(node.right, ctx).type;
      if (node.op === "+") {
        if (l === "number" && r === "number") return { type: "number" };
        if ((l === "text" || r === "text") && !isListType(l) && !isListType(r)) return { type: "text" };
        return operatorError(node.op, l, r, node);
      }
      if (ARITHMETIC.has(node.op)) {
        if (l === "number" && r === "number") return { type: "number" };
        return operatorError(node.op, l, r, node);
      }
      if (node.op === "and" || node.op === "or") {
        if (l === "checkbox" && r === "checkbox") return { type: "checkbox" };
        return operatorError(node.op, l, r, node);
      }
      // Any two lists compare as their texts.
      if (l !== r && !(isListType(l) && isListType(r))) return operatorError(node.op, l, r, node);
      if (ORDERING.has(node.op) && l !== "number" && l !== "text" && l !== "date") return operatorError(node.op, l, r, node);
      return { type: "checkbox" };
    }
    case "call":
      return callType(node, ctx);
  }
}

/** `prop(row, "…")`: a property of a related row, typed from the related database. */
function relatedProp(node: Extract<Node, { kind: "prop" }>, ctx: CheckContext): Typed {
  const row = typeOf(node.row!, ctx);
  if (row.type !== "row") {
    fail("argumentType", `prop() expects row as argument 1, not ${row.type}`, { name: "prop", index: 1, expected: "row", actual: row.type }, node.row);
  }
  const field = row.database ? ctx.related?.(row.database, node.key) : undefined;
  if (!field) fail("unknownProperty", `Unknown property "${node.key}"`, { name: node.key }, node.keyAt);
  if (field.relatedReads) {
    fail("relatedDepth", `"${field.name}" reads related rows itself, which a formula can't read from another database`, { name: field.name }, node.keyAt);
  }
  if (!field.type) fail("referenceError", `"${field.name}" has an error`, { name: field.name }, node.keyAt);
  // A related row's own relations read as titles: formulas go one step at most.
  const type = field.type === "rows" || field.type === "row" ? "list" : field.type;
  ctx.notes.reads.set(node, { database: row.database!, field });
  ctx.notes.types.set(node, type);
  return { type };
}

function callType(node: Extract<Node, { kind: "call" }>, ctx: CheckContext): Typed {
  const at = { start: node.start, end: node.end };
  const spec = FUNCTIONS[node.name.toLowerCase()];
  if (!spec) fail("unknownFunction", `Unknown function "${node.name}"`, { name: node.name }, at);
  const count = node.args.length;
  if (count < spec.min || count > spec.max) {
    const expected =
      spec.min === spec.max ? String(spec.min) : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`;
    fail(
      "argumentCount",
      `${spec.name}() takes ${expected} argument${expected === "1" ? "" : "s"}, not ${count}`,
      { name: spec.name, min: spec.min, max: spec.max === Infinity ? "" : spec.max, actual: count },
      at,
    );
  }
  // Point at the whole call when the function itself complains.
  const pointAt = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof FormulaFailure && error.error.start === undefined) Object.assign(error.error, at);
      throw error;
    }
  };
  let typed: Typed[];
  if (spec.perItem) {
    const list = typeOf(node.args[0], ctx);
    pointAt(() => argType(spec.name, 0, list.type, LISTS));
    ctx.scope.push({ type: itemType(list.type), database: list.database });
    try {
      typed = [list, typeOf(node.args[1], ctx)];
    } finally {
      ctx.scope.pop();
    }
  } else typed = node.args.map((a) => typeOf(a, ctx));
  const type = pointAt(() =>
    spec.check(
      typed.map((t) => t.type),
      node.args,
      spec.name,
    ),
  );
  const result: Typed = { type };
  if (type === "row" || type === "rows") {
    const from = spec.branches ? spec.branches(count) : spec.rowsFrom !== undefined ? [spec.rowsFrom] : typed.map((_, i) => i);
    const databases = [...new Set(from.flatMap((i) => (typed[i].database ? [typed[i].database!] : [])))];
    if (spec.branches && databases.length > 1) {
      fail("branchTypes", `${spec.name}() needs every result to come from the same database`, { name: spec.name, left: type, right: type }, at);
    }
    result.database = databases[0];
  }
  if (spec.branches && type === "list" && spec.branches(count).some((i) => typed[i].type !== "list")) ctx.notes.asTexts.add(node);
  if (!isListType(type)) ctx.notes.types.set(node, type);
  return result;
}

function compare(a: Value, b: Value): number {
  if (isDate(a) && isDate(b)) return a.date - b.date;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = formatValue(a);
  const y = formatValue(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function equals(a: Value, b: Value) {
  if (a === null || b === null) return a === b;
  // The same related row, even when two rows have one title.
  if (isRow(a) && isRow(b)) return a.rowId === b.rowId;
  return compare(a, b) === 0;
}

/** Numbers of an arithmetic operation: empty counts as 0 unless both sides are empty. */
function operands(a: Value, b: Value): [number, number] | null {
  const x = asNum(a);
  const y = asNum(b);
  if (x === null && y === null) return null;
  return [x ?? 0, y ?? 0];
}

/** Evaluates a checked expression on one row. Styles stay on the result (see plain()). */
export function evaluate(node: Node, env: EvalEnv): Value {
  switch (node.kind) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "current":
      if (!env.current) fail("currentOutside", '"current" can only be used inside map(), filter() and the like');
      return env.current.value;
    case "prop": {
      if (!node.row) return env.value(node.key);
      const row = plain(evaluate(node.row, env));
      if (!isRow(row)) return emptyOf(env.notes?.types.get(node));
      if (row.beyond) {
        fail("relatedLimit", `A formula reads the properties of at most ${MAX_RELATED_ROWS} related rows of a relation`, {
          max: MAX_RELATED_ROWS,
        });
      }
      if (!env.related) throw new HiddenValue();
      return plain(env.related(row, node.key));
    }
    case "unary": {
      const v = plain(evaluate(node.arg, env));
      if (node.op === "not") return v !== true;
      return typeof v === "number" ? -v : null;
    }
    case "binary": {
      if (node.op === "and") return truthy(node.left, env) && truthy(node.right, env);
      if (node.op === "or") return truthy(node.left, env) || truthy(node.right, env);
      const left = evaluate(node.left, env);
      const right = evaluate(node.right, env);
      const l = plain(left);
      const r = plain(right);
      switch (node.op) {
        case "+": {
          // Text keeps each side's styles.
          if (typeof l === "string" || typeof r === "string") return joinStyled([left, right]);
          const n = operands(l, r);
          return n && n[0] + n[1];
        }
        case "-":
        case "*":
        case "/":
        case "%":
        case "^": {
          const n = operands(l, r);
          if (!n) return null;
          const [x, y] = n;
          if (node.op === "/" || node.op === "%") {
            // An empty divisor leaves the result empty: a row that isn't filled in yet isn't an error.
            if (asNum(r) === null) return null;
            if (y === 0) fail("divisionByZero", "Division by zero");
          }
          return node.op === "-" ? x - y : node.op === "*" ? x * y : node.op === "/" ? x / y : node.op === "%" ? x % y : x ** y;
        }
        case "==":
          return equals(l, r);
        case "!=":
          return !equals(l, r);
        default: {
          // Empty values never satisfy an ordering (like empty cells in filters).
          if (l === null || r === null) return false;
          const c = compare(l, r);
          return node.op === "<" ? c < 0 : node.op === "<=" ? c <= 0 : node.op === ">" ? c > 0 : c >= 0;
        }
      }
    }
    case "call": {
      const spec = FUNCTIONS[node.name.toLowerCase()];
      let out: Value;
      if (spec.lazy) out = spec.lazy(node.args, env, node);
      else {
        const values = node.args.map((a) => evaluate(a, env));
        out = spec.run!(spec.styled ? values : values.map(plain), env, node);
      }
      // Branches mixing kinds of lists give texts (see sameTypes).
      if (env.notes?.asTexts.has(node)) {
        const p = plain(out);
        if (Array.isArray(p)) return textItems(p);
      }
      return out;
    }
  }
}

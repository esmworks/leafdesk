import * as dates from "./dates";
import type { BinaryOp, Node } from "./parser";
import {
  fail,
  FormulaFailure,
  MAX_TEXT_LENGTH,
  typeNames,
  type DateValue,
  type FormulaType,
  type Value,
} from "./types";

/**
 * Type checking and evaluation of a parsed formula. Checking runs once per formula and decides the
 * result type (or a compile error); evaluation runs once per row and may still fail on that row
 * (division by zero, an unreadable date…). Both throw FormulaFailure.
 */

/** A property a formula can read: its current name (for messages) and type; null type = it has an error. */
export type Field = { name: string; type: FormulaType | null };
export type FieldResolver = (key: string) => Field | undefined;

export type EvalEnv = {
  /** The value of `prop(key)` on the row being evaluated; throws for a referenced formula's error. */
  value: (key: string) => Value;
  now: Date;
};

type ArgType = FormulaType | "any";
type Group = "logic" | "text" | "number" | "date" | "conversion";

type FnSpec = {
  group: Group;
  /** Shown in the editor's function list. */
  signature: string;
  min: number;
  max: number;
  /** Returns the result type for these argument types, or throws. */
  check: (types: FormulaType[], args: Node[], name: string) => FormulaType;
  /** Eager functions get their evaluated arguments; lazy ones (if, ifs, and, or) evaluate their own. */
  run?: (values: Value[], env: EvalEnv) => Value;
  lazy?: (args: Node[], env: EvalEnv) => Value;
};

function argType(name: string, index: number, actual: FormulaType, allowed: readonly ArgType[]) {
  if (allowed.includes("any") || allowed.includes(actual)) return;
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
  run: (values: Value[], env: EvalEnv) => Value,
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

const isDate = (v: Value): v is DateValue => typeof v === "object" && v !== null && !Array.isArray(v);
const asText = (v: Value) => (typeof v === "string" ? v : "");
const asList = (v: Value) => (Array.isArray(v) ? v : []);
const asNum = (v: Value) => (typeof v === "number" ? v : null);

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

/** Any value as text: what format() and text concatenation produce. */
export function formatValue(v: Value): string {
  if (v === null) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return dates.formatDate(v);
}

/** Whether a value is empty: no value, "", no items, unchecked, or 0. */
export function isEmptyValue(v: Value) {
  return v === null || v === "" || v === false || v === 0 || (Array.isArray(v) && v.length === 0);
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
  const text = String(v).trim();
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

const extreme = (signature: string, pick: (...n: number[]) => number): FnSpec =>
  fixed(
    "number",
    signature,
    [NUM],
    "number",
    (values) => {
      const nums = values.filter((v): v is number => typeof v === "number");
      return nums.length ? pick(...nums) : null;
    },
    { min: 1, max: Infinity },
  );

function sameTypes(name: string, types: FormulaType[]) {
  const [first, ...rest] = types;
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

/** Every function, by lowercase name. */
const FUNCTIONS: Record<string, FnSpec & { name: string }> = {};
const define = (name: string, spec: FnSpec) => {
  FUNCTIONS[name.toLowerCase()] = { ...spec, name };
};

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
  lazy: ([cond, then, otherwise], env) => (evaluate(cond, env) === true ? evaluate(then, env) : evaluate(otherwise, env)),
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
    for (let i = 0; i < args.length - 1; i += 2) if (evaluate(args[i], env) === true) return evaluate(args[i + 1], env);
    return evaluate(args[args.length - 1], env);
  },
});
define("and", {
  ...fixed("logic", "and(a, b, …)", [BOOL], "checkbox", () => null, { min: 1, max: Infinity }),
  run: undefined,
  lazy: (args, env) => args.every((a) => evaluate(a, env) === true),
});
define("or", {
  ...fixed("logic", "or(a, b, …)", [BOOL], "checkbox", () => null, { min: 1, max: Infinity }),
  run: undefined,
  lazy: (args, env) => args.some((a) => evaluate(a, env) === true),
});
define("not", fixed("logic", "not(value)", [BOOL], "checkbox", ([v]) => v !== true));
define("empty", fixed("logic", "empty(value)", [ANY], "checkbox", ([v]) => isEmptyValue(v)));

// Text
define(
  "concat",
  fixed("text", "concat(a, b, …)", [ANY], "text", (values) => limitText(values.map(formatValue).join("")), {
    min: 1,
    max: Infinity,
  }),
);
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
    Array.isArray(v) ? v.includes(asText(part)) : asText(v).includes(asText(part)),
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
define("join", fixed("text", "join(list, separator)", [["list"], TEXT], "text", ([v, sep]) => limitText(asList(v).join(asText(sep)))));
define("format", fixed("conversion", "format(value)", [ANY], "text", ([v]) => limitText(formatValue(v))));

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

/** The type `node` evaluates to; throws a FormulaFailure (with the node's position) when it can't run. */
export function check(node: Node, fields: FieldResolver): FormulaType {
  const at = { start: node.start, end: node.end };
  switch (node.kind) {
    case "number":
      return "number";
    case "string":
      return "text";
    case "boolean":
      return "checkbox";
    case "prop": {
      const field = fields(node.key);
      if (!field) fail("unknownProperty", `Unknown property "${node.key}"`, { name: node.key }, at);
      if (!field.type) fail("referenceError", `"${field.name}" has an error`, { name: field.name }, at);
      return field.type;
    }
    case "unary": {
      const t = check(node.arg, fields);
      const want = node.op === "-" ? "number" : "checkbox";
      if (t !== want) fail("unaryType", `"${node.op}" can't be used with ${t}`, { op: node.op, type: t }, at);
      return want;
    }
    case "binary": {
      const l = check(node.left, fields);
      const r = check(node.right, fields);
      if (node.op === "+") {
        if (l === "number" && r === "number") return "number";
        if ((l === "text" || r === "text") && l !== "list" && r !== "list") return "text";
        return operatorError(node.op, l, r, node);
      }
      if (ARITHMETIC.has(node.op)) {
        if (l === "number" && r === "number") return "number";
        return operatorError(node.op, l, r, node);
      }
      if (node.op === "and" || node.op === "or") {
        if (l === "checkbox" && r === "checkbox") return "checkbox";
        return operatorError(node.op, l, r, node);
      }
      if (l !== r) return operatorError(node.op, l, r, node);
      if (ORDERING.has(node.op) && l !== "number" && l !== "text" && l !== "date") return operatorError(node.op, l, r, node);
      return "checkbox";
    }
    case "call": {
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
      const types = node.args.map((a) => check(a, fields));
      try {
        return spec.check(types, node.args, spec.name);
      } catch (error) {
        // Point at the whole call when the function itself complains.
        if (error instanceof FormulaFailure && error.error.start === undefined) Object.assign(error.error, at);
        throw error;
      }
    }
  }
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
  return compare(a, b) === 0;
}

/** Numbers of an arithmetic operation: empty counts as 0 unless both sides are empty. */
function operands(a: Value, b: Value): [number, number] | null {
  const x = asNum(a);
  const y = asNum(b);
  if (x === null && y === null) return null;
  return [x ?? 0, y ?? 0];
}

/** Evaluates a checked expression on one row. */
export function evaluate(node: Node, env: EvalEnv): Value {
  switch (node.kind) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "prop":
      return env.value(node.key);
    case "unary": {
      const v = evaluate(node.arg, env);
      if (node.op === "not") return v !== true;
      return typeof v === "number" ? -v : null;
    }
    case "binary": {
      if (node.op === "and") return evaluate(node.left, env) === true && evaluate(node.right, env) === true;
      if (node.op === "or") return evaluate(node.left, env) === true || evaluate(node.right, env) === true;
      const l = evaluate(node.left, env);
      const r = evaluate(node.right, env);
      switch (node.op) {
        case "+": {
          if (typeof l === "string" || typeof r === "string") return limitText(formatValue(l) + formatValue(r));
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
      if (spec.lazy) return spec.lazy(node.args, env);
      return spec.run!(node.args.map((a) => evaluate(a, env)), env);
    }
  }
}

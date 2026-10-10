import { tokenize, type Token } from "./lexer";
import { fail, MAX_FORMULA_DEPTH, MAX_FORMULA_LENGTH } from "./types";

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
export type UnaryOp = "-" | "not";

type Span = { start: number; end: number };
export type Node =
  | ({ kind: "number"; value: number } & Span)
  | ({ kind: "string"; value: string } & Span)
  | ({ kind: "boolean"; value: boolean } & Span)
  /**
   * `prop("…")`: `key` is a property id, a property name or "title" (see checkFormula). With
   * `row` (`prop(row, "…")`), a property of that related row instead. `keyAt` locates the key.
   */
  | ({ kind: "prop"; key: string; row?: Node; keyAt: Span } & Span)
  /** `current`: the list item map(), filter() and the like are looking at. */
  | ({ kind: "current" } & Span)
  | ({ kind: "call"; name: string; args: Node[] } & Span)
  | ({ kind: "unary"; op: UnaryOp; arg: Node } & Span)
  | ({ kind: "binary"; op: BinaryOp; left: Node; right: Node } & Span);

const COMPARISONS: Record<string, BinaryOp> = { "==": "==", "=": "==", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };

/**
 * Parses an expression into a syntax tree, or null for an empty expression. Precedence, loosest
 * first: `or`/`||`, `and`/`&&`, `not`/`!`, comparisons (`== != < <= > >=`, `=` means `==`),
 * `+ -`, `* / %`, unary minus, `^` (right-associative, so `2^3^2` is `2^9` and `-2^2` is -4).
 * Throws a FormulaFailure with the position of the first problem.
 */
export function parse(source: string): Node | null {
  if (source.length > MAX_FORMULA_LENGTH) {
    fail("tooLong", `A formula can be at most ${MAX_FORMULA_LENGTH} characters long`, { max: MAX_FORMULA_LENGTH });
  }
  const tokens = tokenize(source);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (t: Token, ...values: string[]) => t.kind === "op" && values.includes(t.value);
  const isWord = (t: Token, word: string) => t.kind === "name" && t.value.toLowerCase() === word;
  const unexpected = (t: Token): never =>
    t.kind === "eof"
      ? fail("unexpectedEnd", "The formula ends too early", {}, { start: t.start, end: t.end })
      : fail("syntax", `Unexpected "${source.slice(t.start, t.end)}"`, { token: source.slice(t.start, t.end) }, t);
  const expect = (value: string) => {
    const t = next();
    if (t.kind !== "punct" || t.value !== value) unexpected(t);
    return t;
  };
  const nested = <T>(fn: () => T): T => {
    if (++depth > MAX_FORMULA_DEPTH) fail("tooDeep", "The formula is nested too deeply", { max: MAX_FORMULA_DEPTH }, peek());
    try {
      return fn();
    } finally {
      depth--;
    }
  };
  const binary = (op: BinaryOp, left: Node, right: Node): Node => ({ kind: "binary", op, left, right, start: left.start, end: right.end });

  const expression = (): Node => nested(or);
  function or(): Node {
    let left = and();
    while (isOp(peek(), "||") || isWord(peek(), "or")) {
      next();
      left = binary("or", left, and());
    }
    return left;
  }
  function and(): Node {
    let left = not();
    while (isOp(peek(), "&&") || isWord(peek(), "and")) {
      next();
      left = binary("and", left, not());
    }
    return left;
  }
  function not(): Node {
    const t = peek();
    // `not(x)` is also a function; as a keyword it takes the rest of the comparison.
    if (isOp(t, "!") || (isWord(t, "not") && !(tokens[pos + 1]?.kind === "punct" && tokens[pos + 1].value === "("))) {
      next();
      const arg = nested(not);
      return { kind: "unary", op: "not", arg, start: t.start, end: arg.end };
    }
    return comparison();
  }
  function comparison(): Node {
    let left = additive();
    while (peek().kind === "op" && COMPARISONS[peek().value]) {
      const op = COMPARISONS[next().value];
      left = binary(op, left, additive());
    }
    return left;
  }
  function additive(): Node {
    let left = multiplicative();
    while (isOp(peek(), "+", "-")) {
      const op = next().value as BinaryOp;
      left = binary(op, left, multiplicative());
    }
    return left;
  }
  function multiplicative(): Node {
    let left = unary();
    while (isOp(peek(), "*", "/", "%")) {
      const op = next().value as BinaryOp;
      left = binary(op, left, unary());
    }
    return left;
  }
  function unary(): Node {
    const t = peek();
    if (isOp(t, "-", "+")) {
      next();
      const arg = nested(unary);
      if (t.value === "+") return arg;
      // A minus sign on a number literal is part of the number.
      if (arg.kind === "number" && arg.start === t.end) return { ...arg, value: -arg.value, start: t.start };
      return { kind: "unary", op: "-", arg, start: t.start, end: arg.end };
    }
    return power();
  }
  function power(): Node {
    const base = primary();
    if (isOp(peek(), "^")) {
      next();
      return binary("^", base, nested(unary));
    }
    return base;
  }
  function primary(): Node {
    const t = next();
    switch (t.kind) {
      case "number":
        return { kind: "number", value: Number(t.value), start: t.start, end: t.end };
      case "string":
        return { kind: "string", value: t.value, start: t.start, end: t.end };
      case "punct":
        if (t.value === "(") {
          const inner = expression();
          const close = expect(")");
          return { ...inner, start: t.start, end: close.end };
        }
        return unexpected(t);
      case "name": {
        const word = t.value.toLowerCase();
        if (word === "true" || word === "false") return { kind: "boolean", value: word === "true", start: t.start, end: t.end };
        const call = peek().kind === "punct" && peek().value === "(";
        if (word === "current" && !call) return { kind: "current", start: t.start, end: t.end };
        if (!call) {
          fail("syntax", `"${t.value}" needs parentheses: ${t.value}(…)`, { token: t.value }, t);
        }
        next();
        const args: Node[] = [];
        if (peek().kind === "punct" && peek().value === ")") next();
        else {
          for (;;) {
            args.push(expression());
            const sep = next();
            if (sep.kind === "punct" && sep.value === ")") break;
            if (sep.kind !== "punct" || sep.value !== ",") unexpected(sep);
          }
        }
        const end = tokens[pos - 1].end;
        if (word === "prop") {
          // prop("Name") on the row itself, prop(row, "Name") on a related row.
          const key = args[args.length - 1];
          if (args.length < 1 || args.length > 2 || key.kind !== "string") {
            fail(
              "propArgument",
              'prop() takes a property name in quotes, like prop("Price"), or a related row and a name, like prop(current, "Price")',
              {},
              { start: t.start, end },
            );
          }
          const keyAt = { start: key.start, end: key.end };
          if (args.length === 2) return { kind: "prop", key: key.value, row: args[0], keyAt, start: t.start, end };
          return { kind: "prop", key: key.value, keyAt, start: t.start, end };
        }
        return { kind: "call", name: t.value, args, start: t.start, end };
      }
      default:
        return unexpected(t);
    }
  }

  if (peek().kind === "eof") return null;
  const root = expression();
  if (peek().kind !== "eof") unexpected(peek());
  return root;
}

/**
 * Every `prop("…")` key of the row itself an expression mentions, in order of appearance
 * (duplicates dropped). Keys read on related rows (`prop(row, "…")`) are not the row's own.
 */
export function references(node: Node | null): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.kind === "prop") {
      if (n.row) walk(n.row);
      else out.add(n.key);
    } else if (n.kind === "call") n.args.forEach(walk);
    else if (n.kind === "unary") walk(n.arg);
    else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    }
  };
  if (node) walk(node);
  return [...out];
}

export type PropNode = Extract<Node, { kind: "prop" }>;

/** Every `prop(row, "…")` of an expression: reads of related rows' properties. */
export function relatedReads(node: Node | null): PropNode[] {
  const out: PropNode[] = [];
  const walk = (n: Node) => {
    if (n.kind === "prop") {
      if (n.row) {
        out.push(n);
        walk(n.row);
      }
    } else if (n.kind === "call") n.args.forEach(walk);
    else if (n.kind === "unary") walk(n.arg);
    else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    }
  };
  if (node) walk(node);
  return out;
}

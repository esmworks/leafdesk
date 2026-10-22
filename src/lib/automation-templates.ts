/**
 * Templates in an automation's steps: `{{trigger.Status}}`, `{{find.rows.0.title}}`,
 * `{{http.body.customer["e-mail"]}}`. The first part is `trigger` (what started the run), `item`
 * (the found row a "for each" step is on) or a step's id (what that step gave); the rest is a path
 * into it: names after dots (spaces allowed: `trigger.Due date`), list positions as numbers
 * (`rows.0`, `rows[0]`), and names with dots or brackets in quotes (`["a.b"]`). A name is looked
 * up exactly, then without regard to case.
 *
 * How a value is written:
 * - In text (a message, a URL, a header, part of a longer value) a value becomes text: a string as
 *   it is, numbers and true/false as written, a row or a person by its title or name, a list as
 *   its items joined with ", ", anything else as JSON. A path that leads nowhere is empty text.
 * - A value that is one template and nothing else (`"{{find.rows}}"`) keeps its type: a number
 *   stays a number in a JSON body, a list of rows sets a relation to those rows. Leading nowhere,
 *   it is null.
 * Whether an empty result is an error is up to the step: a URL can't be empty, a message can.
 */

export const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Roots a template can start from besides a step's id. */
export const TEMPLATE_ROOTS = ["trigger", "item"] as const;

export type TemplatePath = { root: string; path: (string | number)[] };

/** Parses what is between the braces, or null when it isn't a path. */
export function parsePath(expression: string): TemplatePath | null {
  const text = expression.trim();
  const parts: (string | number)[] = [];
  let i = 0;
  const bare = () => {
    let j = i;
    while (j < text.length && text[j] !== "." && text[j] !== "[") j++;
    const name = text.slice(i, j).trim();
    i = j;
    return name;
  };
  const first = bare();
  if (!first) return null;
  while (i < text.length) {
    if (text[i] === ".") {
      i++;
      const name = bare();
      if (!name) return null;
      parts.push(/^\d+$/.test(name) ? Number(name) : name);
    } else if (text[i] === "[") {
      const close = text.indexOf("]", i);
      if (close === -1) return null;
      const inside = text.slice(i + 1, close).trim();
      i = close + 1;
      if (/^\d+$/.test(inside)) parts.push(Number(inside));
      else if (/^"(?:[^"\\]|\\.)*"$/.test(inside) || /^'(?:[^'\\]|\\.)*'$/.test(inside)) {
        parts.push(inside.slice(1, -1).replace(/\\(.)/g, "$1"));
      } else return null;
    } else return null;
  }
  return { root: first, path: parts };
}

/** How a path is written back (what the editor's variable picker inserts). */
export function formatPath(root: string, path: (string | number)[]) {
  return (
    root +
    path
      .map((part) =>
        typeof part === "number" ? `.${part}` : /^[^.[\]{}"']+$/.test(part) && part.trim() === part ? `.${part}` : `[${JSON.stringify(part)}]`,
      )
      .join("")
  );
}

/** A template for a path, braces and all. */
export const templateFor = (root: string, path: (string | number)[] = []) => `{{${formatPath(root, path)}}}`;

/** Whether text holds a template. */
export const hasTemplate = (text: unknown): text is string => typeof text === "string" && /\{\{[^{}]*\}\}/.test(text);

/** The roots (`trigger`, `item`, step ids) every template in `value` starts from, strings deep inside too. */
export function templateRoots(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE)) {
      const parsed = parsePath(match[1]);
      if (parsed) out.add(parsed.root);
    }
  } else if (Array.isArray(value)) for (const item of value) templateRoots(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) templateRoots(item, out);
  return out;
}

/** The templates in `value` that aren't paths (`{{}}`, `{{a[}}`), as written. */
export function badTemplates(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE)) if (!parsePath(match[1])) out.push(match[0]);
  } else if (Array.isArray(value)) for (const item of value) badTemplates(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) badTemplates(item, out);
  return out;
}

/** What templates resolve against: `trigger`, `item` and each earlier step's output by id. */
export type TemplateScope = Record<string, unknown>;

/** The value at a path, or undefined when it leads nowhere. */
export function lookup(scope: TemplateScope, { root, path }: TemplatePath): unknown {
  let value: unknown = Object.hasOwn(scope, root) ? scope[root] : undefined;
  for (const part of path) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      if (typeof part !== "number") return undefined;
      value = value[part];
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const key = String(part);
      if (Object.hasOwn(record, key)) value = record[key];
      else {
        const folded = Object.keys(record).find((k) => k.toLowerCase() === key.toLowerCase());
        value = folded === undefined ? undefined : record[folded];
      }
    } else return undefined;
  }
  return value;
}

/** A value written into text (see the note at the top). */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter((t) => t !== "").join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.title === "string") return record.title;
    if (typeof record.name === "string") return record.name;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export type Resolved<T> = { value: T; missing: string[] };

/** Text with its templates written in; `missing` lists the paths that led nowhere. */
export function resolveText(text: string, scope: TemplateScope): Resolved<string> {
  const missing: string[] = [];
  const value = text.replace(TEMPLATE, (whole, expression: string) => {
    const parsed = parsePath(expression);
    if (!parsed) return whole;
    const found = lookup(scope, parsed);
    if (found === undefined) missing.push(expression.trim());
    return textOf(found);
  });
  return { value, missing };
}

/** A whole-template string's path, or null when the string is more (or less) than one template. */
export function wholeTemplate(text: string): TemplatePath | null {
  const match = /^\s*\{\{\s*([^{}]*?)\s*\}\}\s*$/.exec(text);
  return match ? parsePath(match[1]) : null;
}

/**
 * A value with templates written into its strings, deep inside arrays and objects (a JSON body,
 * property values): a string that is one template keeps the type of what it finds.
 */
export function resolveValue(value: unknown, scope: TemplateScope, missing: string[] = []): Resolved<unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!hasTemplate(v)) return v;
      const whole = wholeTemplate(v);
      if (whole) {
        const found = lookup(scope, whole);
        if (found === undefined) {
          missing.push(formatPath(whole.root, whole.path));
          return null;
        }
        return found;
      }
      const resolved = resolveText(v, scope);
      missing.push(...resolved.missing);
      return resolved.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), missing };
}

/**
 * A resolved value made fit for a property that holds ids (relation, person) or options (select,
 * multi-select, status): rows and people (`{id}`) become their ids, and text with commas a list.
 * Anything else is left for the property's own check.
 */
export function idsOf(value: unknown): unknown {
  const one = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : v;
  if (Array.isArray(value)) return value.flatMap((v) => (Array.isArray(v) ? v.map(one) : [one(v)])).filter((v) => v !== null && v !== "");
  if (typeof value === "string" && value.includes(",")) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = one(value);
  return single === null || single === "" ? [] : [single];
}

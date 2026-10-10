import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  asFieldValue,
  checkFormula,
  emptyNotes,
  fail,
  fieldType,
  FormulaFailure,
  HiddenValue,
  MAX_RELATED_ROWS,
  parseFormula,
  rewriteReferences,
  rewriteRelatedReferences,
  runFormula,
  toDateValue,
  type CheckNotes,
  type Field,
  type FormulaError,
  type FormulaResultType,
  type FormulaStyle,
  type FormulaType,
  type Node,
  type RelatedResolver,
  type RowRef,
  type Value,
} from "./formula";
import type { RollupFn } from "./aggregate";
import { asFiles } from "./files";
import { holdsPeople } from "./property-types";

/**
 * Derived properties: values worked out whenever rows are read, never stored. Rollups calculate
 * over the rows a row links to (the server works them out, see server/derived and lib/rollup);
 * formulas then compute from the row's own values, rollups included. Pure and client-safe: the
 * server fills them in for every read (app, MCP, CSV, published pages), and the browser
 * recomputes a row's formulas right away when the user edits it, with the same code.
 */

type Prop = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/** Key of the row title in `prop("title")`. */
export const TITLE_FIELD = "title";

/** A value that couldn't be worked out for a row; stored in its place so every reader can show why. */
export type ErrorValue = { error: FormulaError };

export function isErrorValue(value: unknown): value is ErrorValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "error" in value;
}

/**
 * What a rollup's values are: a calculation's format (a percentage is a fraction, 0.25 = 25%; a
 * date range a number of days), or the related values themselves as a list of texts.
 */
export type RollupFormat = "number" | "percent" | "days" | "date" | "list";

export function rollupFormat(fn: RollupFn | undefined): RollupFormat {
  switch (fn) {
    case "show_original":
      return "list";
    case "percent_empty":
    case "percent_not_empty":
    case "percent_checked":
    case "percent_unchecked":
      return "percent";
    case "date_range":
      return "days";
    case "earliest_date":
    case "latest_date":
      return "date";
    default:
      return "number";
  }
}

/** How a formula sees a property's values. */
function baseType(prop: { type: PropertyType; options: PropertyOptions }): FormulaType | null {
  if (prop.type === "rollup") {
    const format = rollupFormat(prop.options.rollup?.function);
    return format === "list" ? "list" : format === "date" ? "date" : "number";
  }
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
    case "select":
    case "status":
      return "text";
    case "number":
    case "checklist":
      return "number";
    case "checkbox":
      return "checkbox";
    case "date":
    case "created_time":
    case "last_edited_time":
      return "date";
    case "relation":
      // Its rows: their titles wherever a list of texts goes, their properties with prop(row, "…").
      return "rows";
    case "multi_select":
    case "person":
    case "created_by":
    case "last_edited_by":
    case "files":
      return "list";
    default:
      return null;
  }
}

/**
 * The type a derived property's values have (formulas: their result type, filled in when
 * properties are read), or null for other properties.
 */
export function derivedType(prop: { type: PropertyType; options: PropertyOptions }): FormulaResultType | null {
  if (prop.type === "formula") return prop.options.formula?.type ?? "text";
  if (prop.type === "rollup") {
    // A rollup listing the related values filters and sorts like text.
    const format = rollupFormat(prop.options.rollup?.function);
    return format === "date" ? "date" : format === "list" ? "text" : "number";
  }
  return null;
}

/**
 * The type filters, sorts and calculations treat a property as: a derived property counts as a
 * property of its result type (a number formula filters like a number).
 */
export function valueType(prop: { type: PropertyType; options: PropertyOptions }): PropertyType {
  return derivedType(prop) ?? prop.type;
}

/**
 * A checked formula. `related`: it reads properties of related rows, itself or through another
 * formula, so it can only be worked out where those rows are loaded (see FormulaContext.related).
 */
export type CompiledFormula = {
  id: string;
  ast: Node | null;
  type: FormulaResultType;
  error: FormulaError | null;
  notes: CheckNotes;
  related: boolean;
};

/**
 * The properties of related databases by id (formula types filled in), for formulas that read
 * related rows; undefined for a database that isn't known here.
 */
export type RelatedSchemas = (databaseId: string) => Prop[] | undefined;

/**
 * Related schemas from what the browser holds of each relation's database (the properties the
 * viewer may know of): enough to check and edit formulas, not to work out what they read.
 */
export function relatedSchemasFrom(
  relations: Record<string, { database: { id: string } | null; properties?: Prop[] } | undefined> | undefined,
): RelatedSchemas {
  const byDatabase = new Map<string, Prop[]>();
  for (const target of Object.values(relations ?? {})) {
    if (target?.database && target.properties?.length) byDatabase.set(target.database.id, target.properties);
  }
  return (databaseId) => byDatabase.get(databaseId);
}

function resolver(props: Prop[], titleNames: string[] = []) {
  const byId = new Map(props.map((p) => [p.id, p]));
  const byName = new Map<string, Prop>();
  for (const p of props) if (!byName.has(p.name.trim().toLowerCase())) byName.set(p.name.trim().toLowerCase(), p);
  const titles = new Set([TITLE_FIELD, ...titleNames.map((n) => n.trim().toLowerCase())]);
  /** A reference by property id, else by (case-insensitive) name, else the row title. */
  return (key: string): Prop | typeof TITLE_FIELD | undefined => {
    const found = byId.get(key) ?? byName.get(key.trim().toLowerCase());
    if (found) return found;
    return titles.has(key.trim().toLowerCase()) ? TITLE_FIELD : undefined;
  };
}

/** Formulas that depend on themselves, directly or through other formulas. */
function cyclic(formulas: Prop[], refsOf: (id: string) => string[]) {
  const out = new Set<string>();
  for (const f of formulas) {
    const seen = new Set<string>();
    const stack = [...refsOf(f.id)];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === f.id) {
        out.add(f.id);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...refsOf(id));
    }
  }
  return out;
}

/**
 * Parses and type checks every formula of a database. A formula that depends on itself gets a
 * cycle error; one that uses a broken formula gets a reference error.
 */
export function compileFormulas(props: Prop[], related?: RelatedSchemas): Map<string, CompiledFormula> {
  const resolve = resolver(props);
  const formulas = props.filter((p) => p.type === "formula");
  const parsed = new Map(formulas.map((f) => [f.id, parseFormula(f.options.formula?.expression ?? "")]));
  const refsOf = (id: string) =>
    (parsed.get(id)?.refs ?? []).flatMap((key) => {
      const target = resolve(key);
      return typeof target === "object" && target.type === "formula" ? [target.id] : [];
    });
  const loops = cyclic(formulas, refsOf);
  const readsRelated = relatedFormulas(formulas, parsed, refsOf);
  const relatedFields = related ? relatedResolver(related) : undefined;
  const out = new Map<string, CompiledFormula>();

  const compile = (f: Prop): CompiledFormula => {
    const done = out.get(f.id);
    if (done) return done;
    const formula = parsed.get(f.id)!;
    let result: CompiledFormula;
    const base = { id: f.id, notes: emptyNotes(), related: readsRelated.has(f.id) };
    if (loops.has(f.id)) {
      const error: FormulaError = { code: "cycle", message: `"${f.name}" refers back to itself`, params: { name: f.name } };
      result = { ...base, ast: null, type: "text", error };
    } else {
      const fields = (key: string): Field | undefined => {
        const target = resolve(key);
        if (!target) return undefined;
        if (target === TITLE_FIELD) return { id: TITLE_FIELD, name: TITLE_FIELD, type: "text" };
        if (target.type === "formula") {
          const compiled = compile(target);
          return { id: target.id, name: target.name, type: compiled.error ? null : fieldType(compiled.type) };
        }
        return field(target);
      };
      const { type, error, notes } = checkFormula(formula, fields, relatedFields);
      result = { ...base, ast: error ? null : formula.ast, type, error, notes };
    }
    out.set(f.id, result);
    return result;
  };
  for (const f of formulas) compile(f);
  return out;
}

/** How a formula sees a property that isn't a formula (relations: rows of their database). */
function field(prop: Prop): Field | undefined {
  const type = baseType(prop);
  if (!type) return undefined;
  const database = prop.type === "relation" ? prop.options.relation?.databaseId : undefined;
  return { id: prop.id, name: prop.name, type, ...(database ? { database } : {}) };
}

/** Formulas that read related rows' properties, themselves or through other formulas. */
function relatedFormulas(formulas: Prop[], parsed: Map<string, ParsedFormulaLike>, refsOf: (id: string) => string[]) {
  const out = new Set(formulas.filter((f) => parsed.get(f.id)?.related).map((f) => f.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of formulas) {
      if (!out.has(f.id) && refsOf(f.id).some((id) => out.has(id))) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

type ParsedFormulaLike = { related: boolean };

/**
 * The properties of related rows as formulas see them. A related database's formulas are checked
 * there (without related rows of their own): one that reads related rows can't be read from here.
 */
function relatedResolver(related: RelatedSchemas, titleNames: string[] = []): RelatedResolver {
  const byDatabase = new Map<string, ((key: string) => Field | undefined) | null>();
  const fieldsOf = (databaseId: string) => {
    if (byDatabase.has(databaseId)) return byDatabase.get(databaseId)!;
    const props = related(databaseId);
    let fields: ((key: string) => Field | undefined) | null = null;
    if (props) {
      const resolve = resolver(props, titleNames);
      const compiled = compileFormulas(props);
      fields = (key) => {
        const target = resolve(key);
        if (!target) return undefined;
        if (target === TITLE_FIELD) return { id: TITLE_FIELD, name: TITLE_FIELD, type: "text" };
        if (target.type === "formula") {
          const c = compiled.get(target.id)!;
          return { id: target.id, name: target.name, type: c.error ? null : fieldType(c.type), relatedReads: c.related };
        }
        return field(target);
      };
    }
    byDatabase.set(databaseId, fields);
    return fields;
  };
  return (databaseId, key) => fieldsOf(databaseId)?.(key);
}

/** Properties with each formula's result type filled in (see FormulaConfig.type). */
export function withFormulaTypes<P extends Prop>(props: P[], related?: RelatedSchemas): P[] {
  if (!props.some((p) => p.type === "formula")) return props;
  const compiled = compileFormulas(props, related);
  return props.map((p) =>
    p.type === "formula"
      ? { ...p, options: { ...p.options, formula: { expression: p.options.formula?.expression ?? "", type: compiled.get(p.id)!.type } } }
      : p,
  );
}

/**
 * The databases whose properties the formulas of `props` may read: those of the relations a
 * formula reading related rows mentions (rows only come from relations the formula names).
 */
export function relatedDatabases(props: Prop[]): string[] {
  const resolve = resolver(props);
  const out = new Set<string>();
  for (const p of props) {
    if (p.type !== "formula") continue;
    const parsed = parseFormula(p.options.formula?.expression ?? "");
    if (!parsed.related) continue;
    for (const key of parsed.refs) {
      const target = resolve(key);
      if (typeof target === "object" && target.type === "relation" && target.options.relation?.databaseId) {
        out.add(target.options.relation.databaseId);
      }
    }
  }
  return [...out];
}

/** What compiled formulas read of related rows: the properties, by related database id. */
export function relatedReadsOf(compiled: Map<string, CompiledFormula>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const formula of compiled.values()) {
    if (formula.error) continue;
    for (const { database, field } of formula.notes.reads.values()) {
      if (!out.has(database)) out.set(database, new Set());
      if (field.id) out.get(database)!.add(field.id);
    }
  }
  return out;
}

/** Whether any formula reads people or related rows, which need names and titles to evaluate. */
export function formulasNeedLookups(props: Prop[]) {
  const resolve = resolver(props);
  return props.some(
    (p) =>
      p.type === "formula" &&
      parseFormula(p.options.formula?.expression ?? "").refs.some((key) => {
        const target = resolve(key);
        return typeof target === "object" && (target.type === "relation" || holdsPeople(target.type));
      }),
  );
}

/**
 * A related database as formulas read it: its properties, the rows the viewer may see with the
 * values they may see (`hidden`: properties whose values were left out of that row), the
 * properties the viewer can't know of at all, and the names and titles its own people and
 * relations read as.
 */
export type RelatedDatabase = {
  props: Prop[];
  rows: Map<string, { properties: Record<string, unknown>; hidden?: string[] }>;
  unknown: ReadonlySet<string>;
  context: FormulaContext;
};

/**
 * A related database for formulas from its rows as the viewer reads them: values they may not
 * see already left out of `rows` and named in each row's `hidden` (property access strip, derived
 * values, finish, as for the database's own rows), `visible` the properties they may know of.
 */
export function relatedDatabase(
  props: Prop[],
  rows: { id: string; properties: Record<string, unknown>; hidden?: string[] }[],
  visible: (props: Prop[]) => Prop[],
  context: FormulaContext,
): RelatedDatabase {
  const known = new Set(visible(props).map((p) => p.id));
  return {
    props,
    rows: new Map(rows.map((row) => [row.id, { properties: row.properties, ...(row.hidden ? { hidden: row.hidden } : {}) }])),
    unknown: new Set(props.filter((p) => !known.has(p.id)).map((p) => p.id)),
    context,
  };
}

/**
 * What formulas need besides the row: the time (`now()`, `today()`), and the names of people and
 * titles of related rows the viewer may see (people and relations read as lists of those).
 * `related`: the related databases formulas read rows of, by id. Without it, formulas that read
 * related rows aren't worked out (the browser keeps the server's values).
 */
export type FormulaContext = {
  now: Date;
  people?: { id: string; name: string }[];
  relations?: Record<string, { rows: { id: string; title: string }[] } | undefined>;
  related?: ReadonlyMap<string, RelatedDatabase>;
};

const DAY_OR_TIME = (v: unknown) => toDateValue(v);

function optionName(prop: Prop, id: unknown) {
  return prop.options.options?.find((o) => o.id === id)?.name;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/**
 * A value as a formula reads it (also what a rollup showing the original values lists). Other
 * derived values must already be worked out: formulas read the stored result, rollups theirs.
 */
export function readPropertyValue(prop: Prop, value: unknown, ctx: FormulaContext): Value {
  let peopleNames: Map<string, string> | undefined;
  return readValue(prop, value, ctx, () => (peopleNames ??= new Map((ctx.people ?? []).map((p) => [p.id, p.name]))));
}

function readValue(prop: Prop, value: unknown, ctx: FormulaContext, names: () => Map<string, string>): Value {
  if (isErrorValue(value)) return null;
  switch (prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return value === null || value === undefined ? "" : String(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "checkbox":
      return value === true;
    case "select":
    case "status":
      return optionName(prop, value) ?? "";
    case "multi_select":
      return ids(value).flatMap((id) => optionName(prop, id) ?? []);
    case "date":
    case "created_time":
    case "last_edited_time":
      return DAY_OR_TIME(value);
    case "checklist": {
      // The share of ticked items, like checklist sorts.
      if (!Array.isArray(value) || !value.length) return null;
      return value.filter((item) => (item as { checked?: unknown })?.checked === true).length / value.length;
    }
    case "files":
      // File names, in order: `length()` counts them, rollups showing the original list them.
      return asFiles(value).map((file) => file.name);
    case "relation": {
      const titles = new Map((ctx.relations?.[prop.id]?.rows ?? []).map((r) => [r.id, r.title]));
      return ids(value).flatMap((id) => (titles.has(id) ? [titles.get(id)!] : []));
    }
    case "person":
    case "created_by":
    case "last_edited_by": {
      const byId = names();
      return ids(value).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    }
    case "rollup":
    case "formula": {
      // The worked-out value, read by its type.
      const type = prop.type === "rollup" ? baseType(prop) : derivedType(prop);
      if (type === "list") return ids(value);
      if (type === "date") return toDateValue(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : null;
      if (type === "checkbox") return value === true;
      return typeof value === "string" ? value : "";
    }
    default:
      return null;
  }
}

/**
 * One row's formulas worked out. `values`: what gets merged into the row's properties, keyed by
 * property id (a number, text, boolean or date string, null when empty, or an ErrorValue).
 * `styles`: how the styled ones show. `hidden`: formulas that read a value the viewer may not see
 * (a related row's restricted property): they have no value, like a formula over a hidden property
 * of the row itself. Formulas reading related rows are left out of all three without
 * `ctx.related` (the browser keeps what the server worked out).
 */
export type FormulaResults = { values: Record<string, unknown>; styles: Record<string, FormulaStyle>; hidden: string[] };

type Result = { raw: Value; stored: unknown; style: FormulaStyle | null } | { error: FormulaError } | { hidden: true };

/**
 * Works out every formula of one row. `row.properties` must already hold the row's other derived
 * and system values, as the viewer may see them.
 */
export function evaluateRow(
  props: Prop[],
  compiled: Map<string, CompiledFormula>,
  row: { title: string; properties: Record<string, unknown> },
  ctx: FormulaContext,
): FormulaResults {
  const resolve = resolver(props);
  let peopleNames: Map<string, string> | undefined;
  const names = () => (peopleNames ??= new Map((ctx.people ?? []).map((p) => [p.id, p.name])));
  const results = new Map<string, Result>();
  const related = ctx.related ? relatedReader(ctx.related) : undefined;

  const run = (id: string) => {
    const known = results.get(id);
    if (known) return known;
    const formula = compiled.get(id)!;
    let result: Result;
    if (formula.error) result = { error: formula.error };
    else {
      try {
        result = runFormula(formula.ast, { value, now: ctx.now, related, notes: formula.notes });
      } catch (error) {
        if (error instanceof HiddenValue) result = { hidden: true };
        else if (error instanceof FormulaFailure) result = { error: error.error };
        else throw error;
      }
    }
    results.set(id, result);
    return result;
  };

  function value(key: string): Value {
    const target = resolve(key);
    if (!target) return fail("unknownProperty", `Unknown property "${key}"`, { name: key });
    if (target === TITLE_FIELD) return row.title ?? "";
    if (target.type === "formula") {
      const result = run(target.id);
      // A formula over one the viewer may not see shows nothing either.
      if ("hidden" in result) throw new HiddenValue();
      if ("error" in result) return fail("referenceError", `"${target.name}" has an error`, { name: target.name });
      // Other formulas see a list result as the text it is stored as (styles stay).
      return asFieldValue(result.raw);
    }
    const stored = row.properties[target.id];
    // A rollup that couldn't be worked out for this row.
    if (isErrorValue(stored)) return fail("referenceError", `"${target.name}" has an error`, { name: target.name });
    if (target.type === "relation") return relatedRows(target, stored, ctx);
    return readValue(target, stored, ctx, names);
  }

  const out: FormulaResults = { values: {}, styles: {}, hidden: [] };
  for (const [id, formula] of compiled) {
    if (formula.related && !ctx.related) continue;
    const result = run(id);
    if ("hidden" in result) out.hidden.push(id);
    else if ("error" in result) out.values[id] = { error: result.error };
    else {
      out.values[id] = result.stored;
      if (result.style) out.styles[id] = result.style;
    }
  }
  return out;
}

/** Every formula's value for one row, keyed by property id (see evaluateRow). */
export function evaluateFormulas(
  props: Prop[],
  compiled: Map<string, CompiledFormula>,
  row: { title: string; properties: Record<string, unknown> },
  ctx: FormulaContext,
): Record<string, unknown> {
  return evaluateRow(props, compiled, row, ctx).values;
}

/** A row's derived results merged in: formula values and styles, and the formulas it may not see. */
export type WithResults = { styles?: Record<string, FormulaStyle>; hidden?: string[] };

/**
 * A row with its formulas' results merged in: values replaced, styles replaced for the formulas
 * worked out, hidden formulas' values left out and listed with the row's other hidden properties.
 */
export function mergeResults<R extends { properties: Record<string, unknown> } & WithResults>(
  row: R,
  results: FormulaResults,
  compiled: Map<string, CompiledFormula>,
): R {
  const properties = { ...row.properties, ...results.values };
  for (const id of results.hidden) delete properties[id];
  // Styles of formulas worked out here go; those left to the server stay.
  const kept = Object.entries(row.styles ?? {}).filter(([id]) => !compiled.has(id) || !(id in results.values));
  const styles = { ...Object.fromEntries(kept), ...results.styles };
  const hidden = [...new Set([...(row.hidden ?? []), ...results.hidden])];
  const { styles: _s, hidden: _h, ...rest } = row;
  return {
    ...rest,
    properties,
    ...(Object.keys(styles).length ? { styles } : {}),
    ...(hidden.length ? { hidden } : {}),
  } as R;
}

/** Row values with every formula filled in (compiles the schema; use evaluateRow in loops). */
export function withFormulas<R extends { title: string; properties: Record<string, unknown> } & WithResults>(
  props: Prop[],
  rows: R[],
  ctx: FormulaContext,
  related?: RelatedSchemas,
): R[] {
  if (!props.some((p) => p.type === "formula")) return rows;
  const compiled = compileFormulas(props, related);
  return rows.map((row) => mergeResults(row, evaluateRow(props, compiled, row, ctx), compiled));
}

/**
 * A relation as formulas read it: the linked rows the viewer may see (their titles wherever a list
 * of texts goes). Past the first MAX_RELATED_ROWS, rows can't have their properties read.
 */
function relatedRows(prop: Prop, value: unknown, ctx: FormulaContext): RowRef[] {
  const databaseId = prop.options.relation?.databaseId ?? "";
  const titles = new Map((ctx.relations?.[prop.id]?.rows ?? []).map((r) => [r.id, r.title]));
  return ids(value)
    .filter((id) => titles.has(id))
    .map((id, i) => ({ rowId: id, databaseId, title: titles.get(id)!, ...(i >= MAX_RELATED_ROWS ? { beyond: true as const } : {}) }));
}

/**
 * Reads properties of related rows (`prop(row, "…")`) as the viewer may see them: a row that
 * didn't load (the viewer can't open it, or its database), a property they can't know of, or a
 * value left out of that row is hidden.
 */
function relatedReader(databases: ReadonlyMap<string, RelatedDatabase>) {
  const cache = new Map<string, { resolve: ReturnType<typeof resolver>; names: () => Map<string, string> }>();
  const of = (databaseId: string, db: RelatedDatabase) => {
    let found = cache.get(databaseId);
    if (!found) {
      let names: Map<string, string> | undefined;
      found = {
        resolve: resolver(db.props),
        names: () => (names ??= new Map((db.context.people ?? []).map((p) => [p.id, p.name]))),
      };
      cache.set(databaseId, found);
    }
    return found;
  };
  return (row: RowRef, key: string): Value => {
    const db = databases.get(row.databaseId);
    if (!db) throw new HiddenValue();
    const { resolve, names } = of(row.databaseId, db);
    const target = resolve(key);
    if (!target) throw new HiddenValue();
    if (target === TITLE_FIELD) return row.title;
    const data = db.rows.get(row.rowId);
    if (!data || db.unknown.has(target.id) || data.hidden?.includes(target.id)) throw new HiddenValue();
    const stored = data.properties[target.id];
    if (isErrorValue(stored)) return fail("referenceError", `"${target.name}" has an error`, { name: target.name });
    return readValue(target, stored, db.context, names);
  };
}

/**
 * An expression as the user edits it: property ids in `prop("…")` replaced by current names, and
 * the title by `titleName` (the Name column's label) unless a property is called that.
 */
export function formulaForEditing(
  expression: string,
  props: { id: string; name: string }[],
  titleName = TITLE_FIELD,
  /** Properties of related databases the formula may read (`prop(row, "…")` keys are their ids). */
  relatedProps: { id: string; name: string }[] = [],
) {
  const byId = new Map(props.map((p) => [p.id, p.name]));
  const titleTaken = props.some((p) => p.name.trim().toLowerCase() === titleName.trim().toLowerCase());
  const own = rewriteReferences(expression, (key) => {
    if (byId.has(key)) return byId.get(key)!;
    if (key === TITLE_FIELD && !titleTaken) return titleName;
    return null;
  });
  if (!relatedProps.length) return own;
  const related = new Map(relatedProps.map((p) => [p.id, p.name]));
  return rewriteRelatedReferences(own, (node) => related.get(node.key) ?? null);
}

/**
 * An expression as stored: names in `prop("…")` replaced by property ids, and `titleNames` (such
 * as "title" and the Name column's label) by "title". Unknown names stay, so checking reports them.
 * With `related` (and `props` carrying their types), names read on related rows (`prop(row, "…")`)
 * become ids of the related database's properties too, so renaming them there keeps it working.
 */
export function formulaForStorage(
  text: string,
  props: { id: string; name: string; type?: PropertyType; options?: PropertyOptions }[],
  titleNames: string[] = [],
  related?: RelatedSchemas,
) {
  const byId = new Set(props.map((p) => p.id));
  const byName = new Map<string, string>();
  for (const p of props) if (!byName.has(p.name.trim().toLowerCase())) byName.set(p.name.trim().toLowerCase(), p.id);
  const titles = new Set([TITLE_FIELD, ...titleNames.map((n) => n.trim().toLowerCase())]);
  const own = rewriteReferences(text, (key) => {
    if (byId.has(key)) return key;
    const needle = key.trim().toLowerCase();
    if (byName.has(needle)) return byName.get(needle)!;
    return titles.has(needle) ? TITLE_FIELD : null;
  });
  const parsed = parseFormula(own);
  if (!related || !parsed.related) return own;
  // Which related database each `prop(row, "…")` reads comes out of type checking.
  const full = props.filter((p): p is Prop => p.type !== undefined && p.options !== undefined);
  const compiled = compileFormulas(full);
  const resolve = resolver(full);
  const fields = (key: string): Field | undefined => {
    const target = resolve(key);
    if (!target) return undefined;
    if (target === TITLE_FIELD) return { id: TITLE_FIELD, name: TITLE_FIELD, type: "text" };
    if (target.type === "formula") {
      const c = compiled.get(target.id)!;
      return { id: target.id, name: target.name, type: c.error ? null : fieldType(c.type) };
    }
    return field(target);
  };
  const { notes } = checkFormula(parsed, fields, relatedResolver(related, titleNames));
  const ids = new Map([...notes.reads].map(([node, read]) => [node.start, read.field.id]));
  return rewriteRelatedReferences(own, (node) => ids.get(node.start) ?? null);
}

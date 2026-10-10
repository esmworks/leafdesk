import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import { isApplicable, isRollupFn, rollupValues, type RollupFn } from "./aggregate";
import { isErrorValue, readPropertyValue, TITLE_FIELD, valueType, type ErrorValue, type FormulaContext } from "./derived";
import { formatValue, type FormulaErrorCode } from "./formula";

/**
 * Rollups: a calculation over one property of the rows a row links to through a relation (see
 * RollupConfig). Pure: the server loads the related rows the viewer may see, all at once (see
 * server/derived), and works out every row's rollups here.
 */

type Prop = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/** A related row with its values worked out (stored, system and derived). */
export type RelatedRow = { title: string; properties: Record<string, unknown> };

/** A rollup ready to run: its relation, the related database's property it reads, and what it does. */
export type ResolvedRollup = {
  fn: RollupFn;
  relation: Prop;
  /** The target property, or "title" for the related rows' titles. */
  target: Prop | typeof TITLE_FIELD;
};

export function rollupError(code: FormulaErrorCode, message: string, params: Record<string, string> = {}): ErrorValue {
  return { error: { code, message, params } };
}

/** The relation a rollup reads through, if it still exists. */
export function rollupRelation(prop: Prop, props: Prop[]): Prop | undefined {
  const id = prop.options.rollup?.relationPropertyId;
  const relation = props.find((p) => p.id === id);
  return relation?.type === "relation" && relation.options.relation ? relation : undefined;
}

/**
 * Checks a rollup's settings against its database (`props`) and the related database's properties
 * (`targetProps`, undefined when the viewer can't see the related database or it is gone). Returns
 * what to run, or the error every row shows.
 */
export function resolveRollup(prop: Prop, props: Prop[], targetProps: Prop[] | undefined): ResolvedRollup | ErrorValue {
  const config = prop.options.rollup;
  const relation = rollupRelation(prop, props);
  if (!config || !relation) {
    return rollupError("rollupRelation", "The relation this rollup reads no longer exists", { name: prop.name });
  }
  if (!isRollupFn(config.function)) {
    return rollupError("rollupFunction", `Unknown rollup function "${String(config.function)}"`, {
      name: prop.name,
      function: String(config.function),
      property: "",
    });
  }
  if (config.targetPropertyId === TITLE_FIELD) return { fn: config.function, relation, target: TITLE_FIELD };
  // A related database the viewer can't see (or that is gone) has no rows for them: nothing to
  // check, and every row rolls up nothing.
  if (!targetProps) return { fn: config.function, relation, target: unknownTarget(config.targetPropertyId) };
  const target = targetProps.find((p) => p.id === config.targetPropertyId);
  if (!target) {
    return rollupError("rollupTarget", "The property this rollup reads no longer exists", { name: prop.name });
  }
  if (config.function !== "show_original" && !isApplicable(config.function, valueType(target))) {
    return rollupError("rollupFunction", `A rollup can't calculate "${config.function}" for "${target.name}"`, {
      name: prop.name,
      function: config.function,
      property: target.name,
    });
  }
  return { fn: config.function, relation, target };
}

const unknownTarget = (id: string): Prop => ({ id, name: id, type: "text", options: {} });

const ids = (v: unknown): string[] => [
  ...new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
];

/**
 * One row's rollup value: the calculation over the rows its relation value links to, among
 * `related` (the rows the viewer may see, by id; others don't count). A number (a percentage as
 * a fraction, a date range in days), a date string, a list of texts ("show_original"), null when
 * there's nothing to show, or the error a related value couldn't be worked out with.
 * `ctx` names people and linked rows for "show_original" (the related database's lookups).
 */
export function rollupValue(
  rollup: ResolvedRollup,
  relationValue: unknown,
  related: ReadonlyMap<string, RelatedRow>,
  ctx: FormulaContext,
): unknown {
  const { fn, target } = rollup;
  const rows = ids(relationValue).flatMap((id) => {
    const row = related.get(id);
    return row ? [row] : [];
  });
  const values = rows.map((row) => (target === TITLE_FIELD ? row.title : row.properties[target.id]));
  // Rollups of rollups stop somewhere: say so instead of calculating over what's missing.
  const tooDeep = values.find((v) => isErrorValue(v) && v.error.code === "rollupDepth");
  if (tooDeep) return tooDeep;
  const column = target === TITLE_FIELD ? { type: TITLE_FIELD } : { type: valueType(target), options: target.options };
  const label = (value: unknown): string[] => {
    if (target === TITLE_FIELD) return [String(value ?? "")];
    const read = readPropertyValue(target, value, ctx);
    if (Array.isArray(read)) return read.map((item) => formatValue(item));
    return read === null ? [] : [formatValue(read)];
  };
  return rollupValues(values, fn, column, label)?.value ?? null;
}

import type { PropertyOptions, PropertyType, SelectOption } from "@/db/schema/app";

/**
 * Dependent selects: a select or multi-select property can depend on a select property of the
 * same database (PropertyOptions `dependsOn`, "City" on "Country"). Each of its options lists the
 * options of that property it belongs under (`parentOptionIds`); an option without any is always
 * offered. A row holds only options that fit its value of the property it depends on: editors
 * offer only those, a write that sets one that doesn't fit is refused, and when the value it
 * depends on changes, the values that no longer fit are cleared (followDependencies), whichever
 * way the write comes (the app, the REST API, MCP, automations, imports). Pure and client-safe.
 */

type Prop = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/** The types that can depend on another property. */
export function canDepend(type: PropertyType) {
  return type === "select" || type === "multi_select";
}

/** The types another property can depend on: one value per row, from a list. */
export function canBeParent(type: PropertyType) {
  return type === "select";
}

/**
 * The property `prop` depends on, while the dependency holds: a select of `props` (the database's
 * live properties) other than itself. A deleted parent, or one turned into another type, makes
 * every option available again until it comes back.
 */
export function parentOf<P extends Prop>(prop: P, props: readonly P[]): P | null {
  const id = prop.options.dependsOn;
  if (!id || id === prop.id || !canDepend(prop.type)) return null;
  const parent = props.find((p) => p.id === id);
  return parent && canBeParent(parent.type) ? parent : null;
}

/** The live properties depending on `parentId`. */
export function dependentsOf<P extends Prop>(parentId: string, props: readonly P[]): P[] {
  return props.filter((p) => parentOf(p, props)?.id === parentId);
}

/** Whether `option` may be chosen in a row whose value of the parent is `parentValue` (an option id, or none). */
export function fitsParent(option: Pick<SelectOption, "parentOptionIds">, parentValue: unknown): boolean {
  const ids = option.parentOptionIds;
  if (!ids?.length) return true;
  return typeof parentValue === "string" && ids.includes(parentValue);
}

/** The options of `prop` a row with `values` may hold: all of them, unless it depends on another property. */
export function availableOptions<P extends Prop>(prop: P, props: readonly P[], values: Record<string, unknown>): SelectOption[] {
  const options = prop.options.options ?? [];
  const parent = parentOf(prop, props);
  return parent ? options.filter((o) => fitsParent(o, values[parent.id])) : options;
}

/** The option ids a select or multi-select value holds. */
const optionIds = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []);

/** The option ids of a stored value that don't fit `parentValue` (ids of deleted options aren't this rule's business). */
function misfits(prop: Prop, value: unknown, parentValue: unknown): string[] {
  const options = prop.options.options ?? [];
  return optionIds(value).filter((id): id is string => {
    const option = options.find((o) => o.id === id);
    return Boolean(option) && !fitsParent(option!, parentValue);
  });
}

export type DependencyOutcome<P extends Prop> =
  /** Values to write too (null clears one): the dependents whose values the write made unfit. */
  | { ok: true; follow: Record<string, unknown> }
  /** The write itself sets `prop` to `option`, which doesn't fit its value of `parent`. */
  | { ok: false; prop: P; parent: P; option: SelectOption; parentValue: SelectOption | null };

/**
 * What a write does to dependent selects. `before`: the row's stored values; `patch`: the checked
 * values the write sets (null clears). An option the write sets itself that doesn't fit is refused;
 * values of properties depending on one the write changes (or clears) that no longer fit are
 * dropped (a multi-select keeps the ones that still fit), and so on down a chain ("Country",
 * "City", "District").
 */
export function followDependencies<P extends Prop>(
  props: readonly P[],
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): DependencyOutcome<P> {
  const after: Record<string, unknown> = { ...before, ...patch };
  const changed = new Set(Object.keys(patch));
  const follow: Record<string, unknown> = {};
  // Each pass settles a level of the chain; a chain is no longer than the properties.
  for (let pass = 0; pass <= props.length; pass++) {
    let more = false;
    for (const prop of props) {
      const parent = parentOf(prop, props);
      if (!parent || (!changed.has(parent.id) && !(prop.id in patch)) || prop.id in follow) continue;
      const value = after[prop.id];
      if (value === null || value === undefined) continue;
      const parentValue = after[parent.id] ?? null;
      // While the parent stays as it was, options the row already held may stay too: the rule
      // refuses only what a write adds (a choice made before the options were sorted out stays).
      const held = changed.has(parent.id) ? [] : optionIds(before[prop.id]);
      const bad = misfits(prop, value, parentValue).filter((id) => !held.includes(id));
      if (!bad.length) continue;
      if (prop.id in patch) {
        const options = prop.options.options ?? [];
        return {
          ok: false,
          prop,
          parent,
          option: options.find((o) => o.id === bad[0])!,
          parentValue: (parent.options.options ?? []).find((o) => o.id === parentValue) ?? null,
        };
      }
      const kept = Array.isArray(value) ? value.filter((id) => !bad.includes(id)) : [];
      const next = kept.length ? kept : null;
      follow[prop.id] = next;
      after[prop.id] = next;
      changed.add(prop.id);
      more = true;
    }
    if (!more) break;
  }
  return { ok: true, follow };
}

/**
 * Whether `prop` may depend on `parentId` among `props`: a select of the same database other than
 * itself, which doesn't depend on `prop` (directly or down a chain), so no loop forms.
 */
export function dependencyProblem<P extends Prop>(
  prop: P,
  parentId: string,
  props: readonly P[],
): "notDependent" | "notParent" | "loop" | null {
  if (!canDepend(prop.type)) return "notDependent";
  const parent = props.find((p) => p.id === parentId);
  if (!parent || parent.id === prop.id || !canBeParent(parent.type)) return "notParent";
  const seen = new Set<string>([prop.id]);
  for (let at: P | null = parent; at; at = parentOf(at, props)) {
    if (seen.has(at.id)) return "loop";
    seen.add(at.id);
  }
  return null;
}

/**
 * Options as stored for a property depending on `parent` (null: on nothing): each option's
 * `parentOptionIds` keeps the ids that are options of `parent`, once each; an option left with
 * none (or one of a property that depends on nothing) has no list at all.
 */
export function cleanParentOptions(options: SelectOption[], parent: Pick<Prop, "options"> | null): SelectOption[] {
  const known = new Set((parent?.options.options ?? []).map((o) => o.id));
  return options.map((option) => {
    const { parentOptionIds, ...rest } = option;
    const ids = parent ? [...new Set((parentOptionIds ?? []).filter((id) => typeof id === "string" && known.has(id)))] : [];
    return ids.length ? { ...rest, parentOptionIds: ids } : rest;
  });
}

/** Options with no `parentOptionIds`: for a property that no longer depends on another. */
export function withoutParentOptions(options: SelectOption[]): SelectOption[] {
  return options.map(({ parentOptionIds: _parents, ...rest }) => rest);
}

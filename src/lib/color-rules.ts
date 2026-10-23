// A view's color rules (ViewConfig `colorRules`): rows matching a rule's filters take its color, on
// the whole row or card or on one property's value. Pure and client-safe: the views color their
// rows with it, the server checks and rewrites stored rules with it.
import type { ColorRule, FilterEntry, PropertyOptions, ViewConfig } from "@/db/schema/app";
import { filterConfigError, mapFilterRules } from "./filters";
import { filterPredicate, SELECT_COLORS, type RowLike, type ViewViewer } from "./properties";
import type { PropertyType } from "./property-types";

export type ColorRuleColor = (typeof SELECT_COLORS)[number];

/** Rules per view: each is tested on every row the view shows. */
export const MAX_COLOR_RULES = 20;
export const COLOR_RULE_ID = /^[\w-]{1,64}$/;

export function isColorRuleColor(value: unknown): value is ColorRuleColor {
  return (SELECT_COLORS as readonly unknown[]).includes(value);
}

/** Why a view config's color rules can't be stored, or null when they can (property ids aren't checked). */
export function colorRulesConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "colorRules must be a list";
  if (value.length > MAX_COLOR_RULES) return `A view can have at most ${MAX_COLOR_RULES} color rules`;
  const ids = new Set<string>();
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "Each color rule must be an object";
    const { id, color, propertyId, filters, filterCombinator, ...rest } = item as Record<string, unknown>;
    if (typeof id !== "string" || !COLOR_RULE_ID.test(id)) return "Each color rule needs an id of letters, digits, - or _";
    if (ids.has(id)) return `Two color rules have the id "${id}"`;
    ids.add(id);
    if (Object.keys(rest).length) return `Color rule "${id}": unknown setting "${Object.keys(rest)[0]}"`;
    if (!isColorRuleColor(color)) return `Color rule "${id}": color must be one of ${SELECT_COLORS.join(", ")}`;
    if (propertyId !== undefined && (typeof propertyId !== "string" || !propertyId)) {
      return `Color rule "${id}": propertyId must be a property id`;
    }
    if (!Array.isArray(filters)) return `Color rule "${id}": filters must be a list`;
    const error = filterConfigError({ filters, filterCombinator } as Pick<ViewConfig, "filters" | "filterCombinator">);
    if (error) return `Color rule "${id}": ${error}`;
  }
  return null;
}

/** Whether a rule names a property `gone` holds: as its target, or in any of its filters. */
export function colorRuleMentions(rule: ColorRule, gone: (propertyId: string) => boolean): boolean {
  if (rule.propertyId !== undefined && gone(rule.propertyId)) return true;
  let found = false;
  mapFilterRules(rule.filters ?? [], (f) => {
    if (gone(f.propertyId)) found = true;
    return f;
  });
  return found;
}

/**
 * A view's color rules without those that name a property `gone` holds. A rule goes whole rather
 * than losing a condition, so no rule ever colors more rows than its author set it up to.
 */
export function dropColorRules(rules: ColorRule[] | undefined, gone: (propertyId: string) => boolean): ColorRule[] | undefined {
  if (!rules) return rules;
  return rules.some((r) => colorRuleMentions(r, gone)) ? rules.filter((r) => !colorRuleMentions(r, gone)) : rules;
}

/**
 * The rules someone saved who couldn't see the stored rules naming `gone` properties, with those
 * put back, each right after the rule it followed before (or first).
 */
export function restoreColorRules(
  stored: ColorRule[] | undefined,
  next: ColorRule[] | undefined,
  gone: (propertyId: string) => boolean,
): ColorRule[] | undefined {
  const hidden = (stored ?? []).filter((r) => colorRuleMentions(r, gone));
  if (!hidden.length) return next;
  const out = [...(next ?? [])].filter((r) => !hidden.some((h) => h.id === r.id));
  stored!.forEach((rule, i) => {
    if (!hidden.includes(rule)) return;
    const before = stored!.slice(0, i).findLast((prev) => out.some((r) => r.id === prev.id));
    out.splice(before === undefined ? 0 : out.findIndex((r) => r.id === before.id) + 1, 0, rule);
  });
  return out;
}

/** The filter trees of a view's color rules (for reading what they name, people say). */
export function colorRuleFilters(config: Pick<ViewConfig, "colorRules">): FilterEntry[] {
  return (config.colorRules ?? []).flatMap((r) => r.filters ?? []);
}

/** What one row is colored: its background, and the values of some properties (by id, or "title"). */
export type RowColors = { row?: ColorRuleColor; cells?: Readonly<Record<string, ColorRuleColor>> };

type Prop = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/**
 * Each row's colors under `rules`: per target (the row, or one property) the first rule whose
 * filters the row matches. A rule with nothing to test yet (no complete condition) colors no row.
 * Rows without a color are left out. Rules on a property the view doesn't know are skipped.
 *
 * `previous`, the result of the last pass, lends its entries to rows colored the same, so memoized
 * cards given `colors.get(row.id)` don't redraw when only other rows changed.
 */
export function colorRows<T extends RowLike>(
  rows: readonly T[],
  rules: ColorRule[] | undefined,
  props: Prop[],
  viewer: Omit<ViewViewer, "people"> = {},
  previous?: ReadonlyMap<string, RowColors>,
): ReadonlyMap<string, RowColors> {
  const out = new Map<string, RowColors>();
  if (!rules?.length || !rows.length) return out;
  const known = new Set(["title", ...props.map((p) => p.id)]);
  // In rule order, grouped by target: "" for the row.
  const targets = new Map<string, { color: ColorRuleColor; test: (row: T) => boolean }[]>();
  for (const rule of rules) {
    if (!isColorRuleColor(rule.color)) continue;
    const target = rule.propertyId ?? "";
    if (target && !known.has(target)) continue;
    const test = filterPredicate<T>(rule.filters, rule.filterCombinator, props, viewer);
    if (!test) continue;
    const list = targets.get(target) ?? [];
    list.push({ color: rule.color, test });
    targets.set(target, list);
  }
  if (!targets.size) return out;
  for (const row of rows) {
    let rowColor: ColorRuleColor | undefined;
    let cells: Record<string, ColorRuleColor> | undefined;
    for (const [target, list] of targets) {
      const hit = list.find((r) => r.test(row));
      if (!hit) continue;
      if (!target) rowColor = hit.color;
      else (cells ??= {})[target] = hit.color;
    }
    if (!rowColor && !cells) continue;
    const next: RowColors = { ...(rowColor ? { row: rowColor } : {}), ...(cells ? { cells } : {}) };
    const before = previous?.get(row.id);
    out.set(row.id, before && sameColors(before, next) ? before : next);
  }
  return out;
}

function sameColors(a: RowColors, b: RowColors) {
  if (a.row !== b.row) return false;
  const ak = Object.keys(a.cells ?? {});
  const bk = Object.keys(b.cells ?? {});
  return ak.length === bk.length && ak.every((k) => a.cells![k] === b.cells?.[k]);
}

/** Classes giving an element a color's tint (the `--opt-mark` of globals.css), or none. */
export function colorMarkClass(color: ColorRuleColor | undefined): string | undefined {
  return color ? `tint-${color} color-mark` : undefined;
}

/**
 * Classes for one value on a card or list line that a rule colors (`key`: a property id or
 * "title"): a small tinted box that leaves the text where it was.
 */
export function cellMarkClass(colors: RowColors | undefined, key: string): string | undefined {
  const color = colors?.cells?.[key];
  return color ? `tint-${color} color-mark -mx-1 rounded px-1` : undefined;
}

/** A new rule's id, unlike any of `taken`'s. */
export function newColorRuleId(taken: ColorRule[] = []): string {
  for (;;) {
    const id = `c${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.some((r) => r.id === id)) return id;
  }
}

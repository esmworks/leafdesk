import type {
  FilterCombinator,
  FilterEntry,
  FilterGroup,
  FilterOp,
  FilterRule,
  RelativeDateRange,
  ViewConfig,
} from "@/db/schema/app";

/**
 * A view's filters form a small tree: the top-level list (combined with `filterCombinator`, "and"
 * when missing) holds rules and groups, and each group combines its own rules with its own
 * and/or. Plain rule lists stored before groups existed are valid trees of depth zero.
 */

export const FILTER_OPS = [
  "contains",
  "equals",
  "not_equals",
  "is_empty",
  "is_not_empty",
  "gt",
  "lt",
  "is_within",
] as const satisfies readonly FilterOp[];

export const FILTER_COMBINATORS = ["and", "or"] as const satisfies readonly FilterCombinator[];

export const RELATIVE_DATE_RANGES = [
  "today",
  "this_week",
  "this_month",
  "past_n_days",
  "next_n_days",
] as const satisfies readonly RelativeDateRange[];

/** Groups may hold groups once more: a group's rules can be a group, but not deeper. */
export const MAX_FILTER_DEPTH = 2;
/** Upper bound for "past / next N days" (ten years). */
export const MAX_RELATIVE_DAYS = 3650;
/** Upper bound for rules in one view, counted across all groups. */
export const MAX_FILTER_RULES = 100;

export function isFilterGroup(entry: FilterEntry): entry is FilterGroup {
  return (entry as FilterGroup).type === "group";
}

/** Every rule of a filter tree, depth first. */
export function filterRules(entries: FilterEntry[] = []): FilterRule[] {
  return entries.flatMap((e) => (isFilterGroup(e) ? filterRules(e.rules) : [e]));
}

/**
 * The tree with each rule replaced by `fn(rule)`, or dropped when it returns null. Groups left
 * without rules are dropped too, so removing a property doesn't leave empty groups behind.
 */
export function mapFilterRules(entries: FilterEntry[], fn: (rule: FilterRule) => FilterRule | null): FilterEntry[] {
  return entries.flatMap((e): FilterEntry[] => {
    if (!isFilterGroup(e)) {
      const next = fn(e);
      return next ? [next] : [];
    }
    const rules = mapFilterRules(e.rules, fn);
    return rules.length ? [{ ...e, rules }] : [];
  });
}

/**
 * The tree without rules that don't filter yet (`isActive` false, e.g. "Status is …" while the
 * user is still picking) and without groups that end up empty. What remains is what filters: an
 * empty result filters nothing, and an incomplete rule in an "or" doesn't make the "or" match all.
 */
export function pruneFilters(entries: FilterEntry[], isActive: (rule: FilterRule) => boolean): FilterEntry[] {
  return entries.flatMap((e): FilterEntry[] => {
    if (!isFilterGroup(e)) return isActive(e) ? [e] : [];
    const rules = pruneFilters(e.rules, isActive);
    return rules.length ? [{ ...e, rules }] : [];
  });
}

/**
 * One predicate for a (pruned) filter tree, or null when nothing filters. `test` builds the check
 * for a single rule.
 */
export function compileFilters<R>(
  entries: FilterEntry[],
  combinator: FilterCombinator | undefined,
  test: (rule: FilterRule) => (row: R) => boolean,
): ((row: R) => boolean) | null {
  if (!entries.length) return null;
  const parts = entries.map((e) => (isFilterGroup(e) ? compileFilters(e.rules, e.combinator, test) : test(e)));
  const checks = parts.filter((p): p is (row: R) => boolean => p !== null);
  if (!checks.length) return null;
  return combinator === "or" ? (row) => checks.some((c) => c(row)) : (row) => checks.every((c) => c(row));
}

/**
 * Rules of a (pruned) tree that every matching row must satisfy: those joined to the top by "and"
 * only. A rule inside an "or" is one of several ways to match, so it says nothing about a single
 * row. An "or" with one entry left is just that entry.
 */
export function requiredFilterRules(entries: FilterEntry[], combinator: FilterCombinator | undefined): FilterRule[] {
  if (combinator === "or" && entries.length > 1) return [];
  return entries.flatMap((e) => (isFilterGroup(e) ? requiredFilterRules(e.rules, e.combinator) : [e]));
}

/**
 * Why a view config's filters can't be stored, or null when they can. Checks the shape only
 * (unknown ops, bad groups, too deep); rules may still be incomplete while the user edits them.
 */
export function filterConfigError(config: Pick<ViewConfig, "filters" | "filterCombinator">): string | null {
  const { filters, filterCombinator } = config as { filters?: unknown; filterCombinator?: unknown };
  if (filterCombinator !== undefined && !FILTER_COMBINATORS.includes(filterCombinator as FilterCombinator)) {
    return `Filter combinator must be "and" or "or"`;
  }
  if (filters === undefined) return null;
  if (!Array.isArray(filters)) return "Filters must be a list";
  let count = 0;
  const check = (entries: unknown[], depth: number): string | null => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return "Each filter must be a rule or a group";
      const e = entry as Record<string, unknown>;
      if (e.type === "group") {
        if (depth >= MAX_FILTER_DEPTH) return `Filter groups can be nested at most ${MAX_FILTER_DEPTH} levels deep`;
        if (!FILTER_COMBINATORS.includes(e.combinator as FilterCombinator)) {
          return `A filter group's combinator must be "and" or "or"`;
        }
        if (!Array.isArray(e.rules)) return "A filter group needs a list of rules";
        const error = check(e.rules, depth + 1);
        if (error) return error;
        continue;
      }
      if (typeof e.propertyId !== "string" || !e.propertyId) return "A filter rule needs a property";
      if (!FILTER_OPS.includes(e.op as FilterOp)) {
        return `Unknown filter operator "${String(e.op)}". Use one of: ${FILTER_OPS.join(", ")}`;
      }
      if (e.op === "is_within" && e.value !== undefined && e.value !== null && e.value !== "") {
        if (!RELATIVE_DATE_RANGES.includes(e.value as RelativeDateRange)) {
          return `"is_within" takes one of: ${RELATIVE_DATE_RANGES.join(", ")}`;
        }
      }
      if (e.days !== undefined && !isDayCount(e.days)) {
        return `Days must be a whole number from 1 to ${MAX_RELATIVE_DAYS}`;
      }
      if (++count > MAX_FILTER_RULES) return `A view can have at most ${MAX_FILTER_RULES} filter rules`;
    }
    return null;
  };
  return check(filters, 0);
}

export function isDayCount(days: unknown): days is number {
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_RELATIVE_DAYS;
}

export function isRelativeDateRange(value: unknown): value is RelativeDateRange {
  return RELATIVE_DATE_RANGES.includes(value as RelativeDateRange);
}

/** Ranges that count days from today and need a `days` number. */
export function rangeNeedsDays(range: RelativeDateRange) {
  return range === "past_n_days" || range === "next_n_days";
}

/** A local calendar day as YYYY-MM-DD. */
export function dayString(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The calendar day of a stored value: date properties hold YYYY-MM-DD and are taken as-is;
 * timestamps (created_at, updated_at) count on the local day they fall on.
 */
export function valueDay(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dayString(date);
}

/**
 * First and last day (inclusive, YYYY-MM-DD) of a relative range as seen on `now`'s local day, or
 * null for an unknown range or a missing day count. Weeks start on Monday (ISO 8601, as in
 * Turkey and most of Europe). "Past N days" runs from N days ago through today and "next N days"
 * from today through N days ahead, so every range includes today.
 */
export function relativeDateRange(
  range: unknown,
  days: unknown,
  now: Date,
): { start: string; end: string } | null {
  if (!isRelativeDateRange(range)) return null;
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const day = (offset: number) => dayString(new Date(y, m, d + offset));
  switch (range) {
    case "today":
      return { start: day(0), end: day(0) };
    case "this_week": {
      const sinceMonday = (now.getDay() + 6) % 7;
      return { start: day(-sinceMonday), end: day(6 - sinceMonday) };
    }
    case "this_month":
      return { start: dayString(new Date(y, m, 1)), end: dayString(new Date(y, m + 1, 0)) };
    case "past_n_days":
      return isDayCount(days) ? { start: day(-days), end: day(0) } : null;
    case "next_n_days":
      return isDayCount(days) ? { start: day(0), end: day(days) } : null;
  }
}

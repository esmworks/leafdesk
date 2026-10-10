import type { DependencyConfig, DependencyShift, PropertyOptions } from "@/db/schema/app";
import { dateDays } from "./date-value";

/**
 * Dependencies: a database whose rows wait for other rows of the same database, through a relation
 * with itself whose role is "blocked_by" (see RelationConfig). Its other side lists the rows a row
 * is blocking. When a row's dates move, the rows it blocks follow by the database's rule
 * (`DependencyShift`), and so do the rows those block.
 *
 * Rows can reach the database by paths that don't check for loops (imports, older data), so
 * everything here reads the links defensively: a row never blocks itself and a loop is walked
 * once.
 */

export const DEPENDENCY_SHIFTS = ["overlap", "keep_gap", "none"] as const satisfies readonly DependencyShift[];

type Prop = { id: string; databaseId: string; type: string; options: PropertyOptions };

/** The property listing the rows each row waits for while dependencies are on, or null. */
export function blockedByProperty<P extends Prop>(properties: P[]): P | null {
  return (
    properties.find(
      (p) =>
        p.type === "relation" && p.options.relation?.role === "blocked_by" && p.options.relation.databaseId === p.databaseId,
    ) ?? null
  );
}

/** The property listing the rows each row is blocking (the other side), or null. */
export function blockingProperty<P extends Prop>(properties: P[]): P | null {
  const paired = blockedByProperty(properties)?.options.relation?.pairedPropertyId;
  return (paired && properties.find((p) => p.id === paired && p.type === "relation")) || null;
}

/** Dependency settings as written: null clears a date property. */
export type DependencyInput = {
  shift?: DependencyShift;
  skipWeekends?: boolean;
  startPropertyId?: string | null;
  endPropertyId?: string | null;
};

export type DependencySettings = {
  shift: DependencyShift;
  skipWeekends: boolean;
  /** The date property rows start on; null when it is missing (nothing shifts then). */
  start: string | null;
  /** The date property rows end on; null for one-day rows. */
  end: string | null;
};

/**
 * The settings of a blocked-by property, read tolerantly: a date property that was deleted or
 * turned into another type counts as unset, and an unknown rule as "overlap".
 */
export function dependencySettings<P extends Omit<Prop, "databaseId">>(blockedBy: P, properties: P[]): DependencySettings {
  const config: DependencyConfig = blockedBy.options.relation?.dependencies ?? {};
  const date = (id: string | undefined) =>
    (id && properties.some((p) => p.id === id && p.type === "date") && id) || null;
  const start = date(config.startPropertyId);
  const end = start && date(config.endPropertyId) !== start ? date(config.endPropertyId) : null;
  return {
    shift: DEPENDENCY_SHIFTS.includes(config.shift as DependencyShift) ? config.shift! : "overlap",
    skipWeekends: config.skipWeekends === true,
    start,
    end,
  };
}

/** The rows a row waits for (never itself, each once). */
export function storedBlockers(row: { id: string; properties: Record<string, unknown> }, blockedById: string): string[] {
  const value = row.properties[blockedById];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v !== row.id))];
}

/**
 * Whether `rowId` waiting for `blocker` closes a loop: the blocker waits for the row, directly or
 * through other rows. `blockers` holds each row's blockers as stored.
 */
export function makesDependencyLoop(blockers: Map<string, string[]>, rowId: string, blocker: string): boolean {
  if (blocker === rowId) return true;
  const seen = new Set<string>();
  const stack = [blocker];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === rowId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(blockers.get(id) ?? []));
  }
  return false;
}

export type Span = { start: number; end: number };

/**
 * A row's span: from the start value's first day to the end value's last. Without an end value
 * the start's own end counts (a range, see lib/date-value), else the start day; the end is never
 * before the start. Times count on their day where the code runs. Null without a start.
 */
export function rowSpan(start: unknown, end: unknown): Span | null {
  const s = dateDays(start);
  if (!s) return null;
  const e = end === null || end === undefined ? s.end : (dateDays(end)?.end ?? null);
  return { start: s.start, end: e === null || e < s.start ? s.start : e };
}

/** Monday is 0, Sunday 6. 1970-01-01 (day 0) was a Thursday. */
function weekday(day: number) {
  return (((day + 3) % 7) + 7) % 7;
}

/** The day itself, or the Monday after when it falls on a weekend. */
export function skipWeekend(day: number): number {
  const w = weekday(day);
  return w >= 5 ? day + (7 - w) : day;
}

export type ShiftRow = {
  id: string;
  /** The span now, after the write; null when the row has no start date. */
  span: Span | null;
  blockedBy: string[];
};

export type ShiftInput = {
  rows: ShiftRow[];
  /** Rows whose dates the write changed, with their span before it. */
  moved: Map<string, Span | null>;
  /** Rows that started waiting for another row in this write. */
  linked: Set<string>;
  /** Rows the write set dates of itself: they keep them. */
  fixed: Set<string>;
  shift: DependencyShift;
  skipWeekends: boolean;
};

/**
 * Where the rows waiting for moved rows go, in order of the chain, as `{id, before, after}` for each
 * row that moves. Both rules move a row (keeping its length) only later than all of its blockers'
 * ends: "overlap" when it would start on or before the end of one of them, "keep_gap" by as much as
 * its blockers' ends moved (the most any of them moved later, or the least any moved earlier). A row
 * that starts waiting for another one is moved out of the way by either rule. Rows the write dated
 * itself, and rows without a start, stay where they are.
 */
export function planShifts(input: ShiftInput): { id: string; before: Span; after: Span }[] {
  if (input.shift === "none") return [];
  const rows = new Map(input.rows.map((r) => [r.id, r] as const));
  const spans = new Map(input.rows.map((r) => [r.id, r.span] as const));
  const blockers = (id: string) => (rows.get(id)?.blockedBy ?? []).filter((b) => b !== id && rows.has(b));
  const waiting = new Map<string, string[]>();
  for (const row of input.rows) {
    for (const b of blockers(row.id)) waiting.set(b, [...(waiting.get(b) ?? []), row.id]);
  }

  // Every row the change can reach: newly linked rows, the rows waiting for moved rows, the rows
  // waiting for those, and so on down the chain.
  const reach = new Set<string>();
  const stack = [...input.linked, ...[...input.moved.keys()].flatMap((id) => waiting.get(id) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (reach.has(id) || !rows.has(id)) continue;
    reach.add(id);
    stack.push(...(waiting.get(id) ?? []));
  }

  // Each reached row is placed once, after the reached rows it waits for. Rows in a loop are placed
  // last, in the given order.
  const pending = new Map([...reach].map((id) => [id, blockers(id).filter((b) => reach.has(b)).length] as const));
  const order: string[] = [];
  const ready = [...reach].filter((id) => pending.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of waiting.get(id) ?? []) {
      if (!pending.has(next)) continue;
      const left = pending.get(next)! - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  for (const id of reach) if (!order.includes(id)) order.push(id);

  // How far each row's end moved: by the write, or by this plan.
  const endMoved = new Map<string, number>();
  for (const [id, before] of input.moved) {
    const after = spans.get(id);
    if (before && after) endMoved.set(id, after.end - before.end);
  }

  const out: { id: string; before: Span; after: Span }[] = [];
  for (const id of order) {
    const span = spans.get(id);
    if (!span || input.fixed.has(id)) continue;
    const dated = blockers(id).filter((b) => spans.get(b));
    if (!dated.length) continue;
    const clear = Math.max(...dated.map((b) => spans.get(b)!.end)) + 1;
    let start = span.start;
    if (input.shift === "overlap" || input.linked.has(id)) {
      if (start < clear) start = clear;
    } else {
      const moves = dated.map((b) => endMoved.get(b) ?? 0).filter((d) => d !== 0);
      const later = moves.filter((d) => d > 0);
      const by = later.length ? Math.max(...later) : moves.length ? Math.max(...moves) : 0;
      // Moving earlier stops at the latest blocker's end, and never pulls in a row already late.
      start = by < 0 ? Math.max(start + by, Math.min(start, clear)) : start + by;
    }
    if (input.skipWeekends && start !== span.start) start = skipWeekend(start);
    if (start === span.start) continue;
    const after = { start, end: start + (span.end - span.start) };
    spans.set(id, after);
    endMoved.set(id, after.end - span.end);
    out.push({ id, before: span, after });
  }
  return out;
}

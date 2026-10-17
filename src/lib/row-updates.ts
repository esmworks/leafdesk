/**
 * What the people following a database row hear about it (server/row-follow.ts): the values,
 * title and body one person changed in a burst of edits, summed up as one update. Pure and
 * client-safe.
 */

import { sameValue, storedValue } from "./row-activity";
import type { PropertyType } from "./property-types";

/** One value an update changed: a property's, or the title's (no property). Values as stored (lib/row-activity `storedValue`). */
export type RowValueChange = { propertyId: string | null; propertyType: PropertyType | null; from: unknown; to: unknown };

/** What one person changed in a row: values, in the order they were first changed, and whether the body. */
export type RowUpdate = { changes: RowValueChange[]; body: boolean };

/**
 * An update waits until its author has left the row alone this long, so a burst of edits (typing
 * a value, moving a card back and forth, writing in the body) becomes one notification…
 */
export const ROW_UPDATE_IDLE_MS = 60_000;
/** …and no longer than this after its first change, so someone who keeps editing is still heard. */
export const ROW_UPDATE_MAX_WAIT_MS = 10 * 60_000;

/** When an update first changed at `firstAt` and changed again at `now` goes out. */
export function rowUpdateDueAt(firstAt: Date, now: Date): Date {
  return new Date(Math.min(now.getTime() + ROW_UPDATE_IDLE_MS, firstAt.getTime() + ROW_UPDATE_MAX_WAIT_MS));
}

const keyOf = (change: { propertyId: string | null }) => change.propertyId ?? "";

/**
 * `later` on top of `earlier`: each value goes from what it was before the first change to what
 * the last one left, and a value changed back to where it started is no change at all. The body
 * counts as changed when either changed it.
 */
export function mergeRowUpdates(earlier: RowUpdate, later: RowUpdate): RowUpdate {
  const merged = new Map<string, RowValueChange>();
  for (const change of earlier.changes) merged.set(keyOf(change), { ...change, from: storedValue(change.from), to: storedValue(change.to) });
  for (const change of later.changes) {
    const open = merged.get(keyOf(change));
    if (open) merged.set(keyOf(change), { ...open, propertyType: change.propertyType ?? open.propertyType, to: storedValue(change.to) });
    else merged.set(keyOf(change), { ...change, from: storedValue(change.from), to: storedValue(change.to) });
  }
  return {
    changes: [...merged.values()].filter((c) => !sameValue(c.from, c.to)),
    body: earlier.body || later.body,
  };
}

/** Whether an update has nothing left to tell. */
export const isEmptyRowUpdate = (update: RowUpdate) => !update.body && update.changes.length === 0;

/** Only the changes of `update` a viewer may see: the title's, and the properties in `readable`. */
export function visibleRowUpdate(update: RowUpdate, readable: ReadonlySet<string>): RowUpdate {
  return { changes: update.changes.filter((c) => c.propertyId === null || readable.has(c.propertyId)), body: update.body };
}

/** A stored update as read back; anything not shaped as one reads as no update. */
export function parseRowUpdate(value: unknown): RowUpdate {
  if (!value || typeof value !== "object") return { changes: [], body: false };
  const { changes, body } = value as { changes?: unknown; body?: unknown };
  return {
    changes: Array.isArray(changes)
      ? changes.flatMap((c) =>
          c && typeof c === "object" && (typeof c.propertyId === "string" || c.propertyId === null)
            ? [{ propertyId: c.propertyId, propertyType: c.propertyType ?? null, from: c.from ?? null, to: c.to ?? null }]
            : [],
        )
      : [],
    body: body === true,
  };
}

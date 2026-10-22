/**
 * Merging duplicate rows of a database: one row is kept, the others go to the trash, and the kept
 * row takes, property by property, the value of the row picked for it (or all of them together,
 * for values that hold lists). Pure and client-safe: the merge dialog works out its defaults with
 * it, and server/merge-rows.ts the values it writes, so both agree.
 */

import { asFiles, fileIdOf, type FileValue } from "./files";
import { asChecklist } from "./properties";
import { isReadOnlyType, type PropertyType } from "./property-types";
import { storedValue } from "./row-activity";

/** How many rows one merge takes, the kept one included. */
export const MIN_MERGE_ROWS = 2;
export const MAX_MERGE_ROWS = 5;

/** A choice that keeps the values of every row together, for properties holding lists. */
export const COMBINE = "combine";
/** The key of the title among the choices (property ids are UUIDs, never this). */
export const MERGE_TITLE = "title";

/**
 * The search param that opens a merged row itself (from the trash) rather than the row it was
 * merged into, where links to it lead.
 */
export const MERGED_ORIGINAL_PARAM = "original";

/** For each property (by id, or MERGE_TITLE): the row whose value the kept row takes, or COMBINE. */
export type MergeChoices = Record<string, string>;

export type MergeProperty = {
  id: string;
  name: string;
  type: PropertyType;
  options: { relation?: { databaseId: string; pairedPropertyId?: string | null; role?: string } };
};

export type MergeRow = { id: string; title: string; createdAt: Date | string; properties: Record<string, unknown> };

/** Types whose values are lists the merge can put together. */
const LIST_TYPES: ReadonlySet<string> = new Set(["multi_select", "relation", "person", "files", "checklist"]);

/** Whether a property's value is merged at all: values worked out from the row (formulas, who and when) aren't. */
export const isMergeable = (prop: Pick<MergeProperty, "type">) => !isReadOnlyType(prop.type);

/** Whether a property offers "combine all": lists, but not a row's parent (a row has one at most). */
export const canCombine = (prop: Pick<MergeProperty, "type" | "options">) =>
  LIST_TYPES.has(prop.type) && prop.options.relation?.role !== "parent";

/** Nothing: no value, an empty text or list, or an unticked checkbox (the same as one never ticked). */
export function isEmptyMergeValue(type: string, value: unknown) {
  if (type === "checkbox") return value !== true;
  return storedValue(value) === null;
}

/** The row kept by default: the oldest (the first made), the first given when they tie. */
export function defaultKept(rows: Pick<MergeRow, "id" | "createdAt">[]): string {
  let oldest = rows[0];
  for (const row of rows) if (new Date(row.createdAt).getTime() < new Date(oldest.createdAt).getTime()) oldest = row;
  return oldest.id;
}

/** The kept row first, then the others in the order given: the order "first non-empty" goes by. */
export function inMergeOrder<R extends { id: string }>(rows: R[], keptId: string): R[] {
  return [...rows.filter((r) => r.id === keptId), ...rows.filter((r) => r.id !== keptId)];
}

/**
 * The choice a property starts with: relations combine (the links of every row move to the kept
 * one); anything else takes the kept row's value, or the first other row's that isn't empty when
 * the kept row's is. `sees` says whether the merger may see a row's value of the property; rows
 * they can't aren't picked.
 */
export function defaultChoice(
  prop: Pick<MergeProperty, "id" | "type" | "options">,
  rows: MergeRow[],
  keptId: string,
  sees: (rowId: string) => boolean = () => true,
): string {
  if (prop.type === "relation" && canCombine(prop)) return COMBINE;
  const first = inMergeOrder(rows, keptId).find((r) => sees(r.id) && !isEmptyMergeValue(prop.type, r.properties[prop.id]));
  return first?.id ?? keptId;
}

/** The title the kept row starts with: its own, or the first other row's when it has none. */
export function defaultTitleChoice(rows: MergeRow[], keptId: string): string {
  return inMergeOrder(rows, keptId).find((r) => r.title.trim())?.id ?? keptId;
}

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.length > 0);

/** Every row's list of a property, in merge order, each entry once; null when they hold nothing. */
export function combineValues(type: string, values: unknown[]): unknown {
  switch (type) {
    case "files": {
      const seen = new Set<string>();
      const out: FileValue[] = [];
      for (const value of values) {
        for (const file of asFiles(value)) {
          const key = fileIdOf(file.url) ?? file.url;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(file);
        }
      }
      return out.length ? out : null;
    }
    case "checklist": {
      // Copies of a row share item ids: the same item once, a different one under an id of its own.
      const byId = new Map<string, string>();
      const out: { id: string; text: string; checked: boolean }[] = [];
      for (const value of values) {
        for (const item of asChecklist(value)) {
          const known = byId.get(item.id);
          const key = `${item.text}\u0000${item.checked}`;
          if (known === key) continue;
          const id = known === undefined && item.id ? item.id : crypto.randomUUID();
          byId.set(id, key);
          out.push({ ...item, id });
        }
      }
      return out.length ? out : null;
    }
    default: {
      const out = [...new Set(values.flatMap(strings))];
      return out.length ? out : null;
    }
  }
}

/**
 * A relation value of the kept row once the others are gone: links to merged rows become links to
 * the kept one, and the kept row doesn't link to itself. Only for relations of the database with
 * itself; other relations can't hold its rows.
 */
export function relinkValue(value: unknown, mergedIds: ReadonlySet<string>, keptId: string): string[] {
  return [...new Set(strings(value).map((id) => (mergedIds.has(id) ? keptId : id)))].filter((id) => id !== keptId);
}

/** A choice that can't be made: a row not in the merge, combining what isn't a list, a value hidden from the merger. */
export class MergeChoiceError extends Error {
  constructor(
    message: string,
    readonly property: string,
  ) {
    super(message);
    this.name = "MergeChoiceError";
  }
}

export type MergeValuesInput = {
  databaseId: string;
  keptId: string;
  /** Every row of the merge, the kept one included. */
  rows: MergeRow[];
  properties: MergeProperty[];
  choices: MergeChoices;
  /** Whether the merger may change the property's value in the kept row (property access). */
  canEdit: (propertyId: string) => boolean;
  /** Whether the merger may see the property's value in a row (property access). */
  sees: (propertyId: string, rowId: string) => boolean;
};

export type MergedValues = {
  title: string;
  /** The kept row's properties after the merge, whole. */
  properties: Record<string, unknown>;
  /** The choice each property was merged by (MERGE_TITLE included), defaults filled in. */
  choices: MergeChoices;
};

/**
 * What the kept row holds after the merge. Properties the merger can't change keep the kept row's
 * value whatever was chosen; everything else follows the choices, or the defaults. Relations of
 * the database with itself are relinked (see relinkValue).
 */
export function mergedValues(input: MergeValuesInput): MergedValues {
  const { keptId, rows, choices } = input;
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const kept = byId.get(keptId);
  if (!kept) throw new MergeChoiceError("The kept row isn't one of the rows merged", MERGE_TITLE);
  const merged = new Set(rows.filter((r) => r.id !== keptId).map((r) => r.id));
  const ordered = inMergeOrder(rows, keptId);
  const pick = (name: string, choice: string, combinable: boolean) => {
    if (choice === COMBINE) {
      if (!combinable) throw new MergeChoiceError(`"${name}" doesn't hold a list: pick one row's value`, name);
      return choice;
    }
    if (!byId.has(choice)) throw new MergeChoiceError(`"${name}": the row picked isn't one of the rows merged`, name);
    return choice;
  };

  const titleChoice = pick("title", choices[MERGE_TITLE] ?? defaultTitleChoice(rows, keptId), false);
  const out: MergedValues = { title: byId.get(titleChoice)!.title, properties: { ...kept.properties }, choices: { [MERGE_TITLE]: titleChoice } };

  for (const prop of input.properties) {
    if (!isMergeable(prop)) continue;
    const combinable = canCombine(prop);
    const sees = (rowId: string) => input.sees(prop.id, rowId);
    let choice: string;
    if (!input.canEdit(prop.id)) {
      choice = keptId;
    } else {
      choice = pick(prop.name, choices[prop.id] ?? defaultChoice(prop, rows, keptId, sees), combinable);
      if (choice !== COMBINE && choice !== keptId && !sees(choice)) {
        throw new MergeChoiceError(`"${prop.name}": you can't see that row's value`, prop.name);
      }
    }
    out.choices[prop.id] = choice;
    let value: unknown =
      choice === COMBINE
        ? combineValues(
            prop.type,
            ordered.filter((r) => r.id === keptId || sees(r.id)).map((r) => r.properties[prop.id]),
          )
        : byId.get(choice)!.properties[prop.id];
    if (prop.type === "relation" && prop.options.relation?.databaseId === input.databaseId) {
      const ids = relinkValue(value, merged, keptId);
      value = ids.length ? ids : null;
    }
    if (isEmptyMergeValue(prop.type, value)) delete out.properties[prop.id];
    else out.properties[prop.id] = value;
  }
  return out;
}

/**
 * The value of a two-way relation in a row linked to the kept row or to a merged one, once the
 * merge is done: links to merged rows go, and the row links to the kept row exactly when the kept
 * row's value of the paired property lists it, so both sides agree.
 */
export function pairedValue(value: unknown, mergedIds: ReadonlySet<string>, keptId: string, listedByKept: boolean): string[] {
  const rest = strings(value).filter((id) => id !== keptId && !mergedIds.has(id));
  return [...new Set(listedByKept ? [...rest, keptId] : rest)];
}

/** A one-way relation's value in a row linking to a merged row: the link goes to the kept row instead. */
export function repointedValue(value: unknown, mergedIds: ReadonlySet<string>, keptId: string): string[] {
  return [...new Set(strings(value).map((id) => (mergedIds.has(id) ? keptId : id)))];
}

/** Whether one of `starts` would be under itself: a cycle among the rows' parents (sub-items). */
export function makesParentLoop(parents: ReadonlyMap<string, string | null>, starts: Iterable<string> = parents.keys()): boolean {
  for (const start of starts) {
    const path = new Set<string>();
    for (let at: string | null | undefined = start; at; at = parents.get(at)) {
      if (path.has(at)) return true;
      path.add(at);
    }
  }
  return false;
}

/** Whether one of `starts` would wait for itself: a cycle among the rows' blockers (dependencies). */
export function makesBlockerLoop(blockers: ReadonlyMap<string, readonly string[]>, starts: Iterable<string> = blockers.keys()): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of blockers.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  for (const id of starts) if (visit(id)) return true;
  return false;
}

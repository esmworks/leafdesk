import type { PropertyOptions, SubItemsDisplay, ViewConfig } from "@/db/schema/app";

/**
 * Sub-items: a database turned into a tree by a relation with itself whose role is "parent" (see
 * RelationConfig). Each row holds at most one parent; the rows that name a row as their parent are
 * its sub-items, and the paired property of a two-way relation lists them.
 *
 * Rows can reach the database by paths that don't check the tree (imports, older data), so
 * everything here reads it defensively: only the first parent counts, a row can't be its own
 * parent, and a loop of parents is broken at the row that comes first.
 */

export const SUB_ITEMS_DISPLAYS = ["nested", "flat", "parents"] as const satisfies readonly SubItemsDisplay[];

type Prop = { id: string; databaseId: string; type: string; options: PropertyOptions };
type TreeRow = { id: string; properties: Record<string, unknown> };

/** The property holding each row's parent while sub-items are on, or null. */
export function parentProperty<P extends Prop>(properties: P[]): P | null {
  return (
    properties.find(
      (p) => p.type === "relation" && p.options.relation?.role === "parent" && p.options.relation.databaseId === p.databaseId,
    ) ?? null
  );
}

/** The property listing each row's sub-items (the parent property's other side), or null. */
export function subItemsProperty<P extends Prop>(properties: P[]): P | null {
  const parent = parentProperty(properties);
  const paired = parent?.options.relation?.pairedPropertyId;
  return (paired && properties.find((p) => p.id === paired && p.type === "relation")) || null;
}

/** How a view shows the rows: always "flat" without sub-items. */
export function subItemsDisplay(config: Pick<ViewConfig, "subItems">, parent: Prop | null): SubItemsDisplay {
  if (!parent) return "flat";
  return SUB_ITEMS_DISPLAYS.includes(config.subItems as SubItemsDisplay) ? config.subItems! : "nested";
}

/** The row a row names as its parent (the first one, never itself), or null. */
export function storedParent(row: TreeRow, parentId: string): string | null {
  const value = row.properties[parentId];
  if (!Array.isArray(value)) return null;
  const first = value.find((v): v is string => typeof v === "string");
  return first && first !== row.id ? first : null;
}

/**
 * Each row's parent among `rows`: null when it names none, names a row that isn't there, or names
 * one that would close a loop (the first row of a loop, in the given order, becomes a top row).
 */
export function parentsAmong(rows: TreeRow[], parentId: string): Map<string, string | null> {
  const stored = new Map(rows.map((r) => [r.id, storedParent(r, parentId)] as const));
  const among = (id: string | null | undefined) => (id && stored.has(id) ? id : null);
  const parents = new Map<string, string | null>();
  for (const row of rows) {
    let parent = among(stored.get(row.id));
    // Walk up from the parent (through the rows already placed as placed): reaching the row again
    // means a loop, which is broken here.
    const seen = new Set<string>();
    for (let at = parent; at && !seen.has(at); at = parents.has(at) ? parents.get(at)! : among(stored.get(at))) {
      if (at === row.id) {
        parent = null;
        break;
      }
      seen.add(at);
    }
    parents.set(row.id, parent);
  }
  return parents;
}

/** How many sub-items each row has among `rows`. */
export function subItemCounts(rows: TreeRow[], parentId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parent of parentsAmong(rows, parentId).values()) {
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

export type SubItemLine<T> = {
  row: T;
  /** 0 for a top row, 1 for its sub-items, and so on. */
  depth: number;
  /** Sub-items of the row among the rows shown. */
  children: number;
  /** Whether its sub-items show below it. */
  open: boolean;
};

/**
 * The rows as nested lines: each row followed by its sub-items (when open), siblings in the
 * order of `rows`. A row whose parent isn't among `rows` (filtered out, or in another group) is
 * a top row.
 */
export function subItemLines<T extends TreeRow>(rows: T[], parentId: string, isOpen: (rowId: string) => boolean): SubItemLine<T>[] {
  const parents = parentsAmong(rows, parentId);
  const children = new Map<string, T[]>();
  const top: T[] = [];
  for (const row of rows) {
    const parent = parents.get(row.id);
    if (!parent) top.push(row);
    else children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const lines: SubItemLine<T>[] = [];
  const add = (row: T, depth: number) => {
    const below = children.get(row.id) ?? [];
    const open = below.length > 0 && isOpen(row.id);
    lines.push({ row, depth, children: below.length, open });
    if (open) for (const child of below) add(child, depth + 1);
  };
  for (const row of top) add(row, 0);
  return lines;
}

/**
 * The rows of `rows` without a parent in the database (`all`: every row the viewer sees, filters
 * aside), for views showing parents only.
 */
export function topRows<T extends TreeRow>(rows: T[], all: TreeRow[], parentId: string): T[] {
  const parents = parentsAmong(all, parentId);
  return rows.filter((row) => !parents.get(row.id));
}

/**
 * A parent value holds one row: of several, the one newly added wins (the last, when none is new).
 */
export function singleParent(value: string[], existing: string[]): string[] {
  if (value.length <= 1) return value;
  const added = value.filter((id) => !existing.includes(id));
  return [added.length ? added[added.length - 1] : value[value.length - 1]];
}

/**
 * Whether making `parent` the parent of `rowId` would put the row under itself, given each row's
 * stored parent.
 */
export function makesLoop(parents: Map<string, string | null>, rowId: string, parent: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = parent; at && !seen.has(at); at = parents.get(at)) {
    if (at === rowId) return true;
    seen.add(at);
  }
  return false;
}

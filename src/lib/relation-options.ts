import type { RelationConfig } from "@/db/schema/app";

/**
 * Options of relation properties (RelationConfig `single`, `display`, `show`): whether a row links
 * to one row or any number, whether row pages show the linked rows as a section of their own, and
 * what a linked row shows besides its title, in table cells, cards, row pages, that section and the
 * row picker. Pure and client-safe.
 */

/** Where a linked row's title goes among what it shows (lib/derived TITLE_FIELD). */
export const TITLE_FIELD = "title";
/** Properties of the related database a linked row can show beside its title, at most. */
export const MAX_RELATION_SHOW = 4;
/** Linked rows a row page's section lists before "Show more". */
export const SECTION_PAGE = 10;

/**
 * Whether a linked row can show values of this type: not formulas and rollups (worked out with
 * their own database), relations (a row of rows) or files (their thumbnails).
 */
export function showableType(type: string): boolean {
  return type !== "formula" && type !== "rollup" && type !== "relation" && type !== "files";
}

/** A row links to one row at most: a row's parent (sub-items), or a relation limited to one. */
export function linksOne(relation: RelationConfig | undefined | null): boolean {
  return relation?.role === "parent" || relation?.single === true;
}

/** What a linked row shows, in order, with "title" where its title goes. */
export function shownParts(relation: RelationConfig | undefined | null): string[] {
  return relation?.show?.length ? relation.show : [TITLE_FIELD];
}

/** The related database's properties a linked row shows besides its title, in order. */
export function shownPropertyIds(relation: RelationConfig | undefined | null): string[] {
  return (relation?.show ?? []).filter((id) => id !== TITLE_FIELD);
}

/** What the app asks for; null (or "inline") puts an option back to how it was. The limit is updateProperty's oneRow. */
export type RelationOptionsInput = {
  display?: "section" | "inline" | null;
  show?: string[] | null;
};

/**
 * Checks relation options against the property's current relation and the related database's
 * properties the user may know of (null: not checked, for showing a change before the server has
 * checked it), and returns the relation as stored, or what is wrong. `show` keeps its order, drops
 * repeats and gets "title" at its end when it doesn't name it.
 */
export function checkRelationOptions(
  input: RelationOptionsInput,
  current: RelationConfig,
  targetProperties: { id: string; name: string; type: string }[] | null,
): { ok: true; relation: RelationConfig } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "Relation options are an object {display, show}" };
  const { display, show } = input;
  if (display !== undefined && display !== null && display !== "section" && display !== "inline") {
    return { ok: false, message: 'A relation shows "inline" or as a "section"' };
  }
  const next: RelationConfig = { ...current };
  if (display !== undefined) {
    if (display === "section") next.display = "section";
    else delete next.display;
  }
  if (show !== undefined) {
    if (show !== null && !(Array.isArray(show) && show.every((id) => typeof id === "string"))) {
      return { ok: false, message: "What linked rows show is a list of property ids and \"title\"" };
    }
    const ids = [...new Set(show ?? [])];
    for (const id of ids) {
      if (id === TITLE_FIELD || !targetProperties) continue;
      const prop = targetProperties.find((p) => p.id === id);
      if (!prop) return { ok: false, message: `"${id}" is not a property of the related database` };
      if (!showableType(prop.type)) return { ok: false, message: `Linked rows can't show "${prop.name}" (${prop.type})` };
    }
    const others = ids.filter((id) => id !== TITLE_FIELD);
    if (others.length > MAX_RELATION_SHOW) {
      return { ok: false, message: `Linked rows show at most ${MAX_RELATION_SHOW} properties beside their title` };
    }
    if (!others.length) delete next.show;
    else next.show = ids.includes(TITLE_FIELD) ? ids : [...ids, TITLE_FIELD];
  }
  return { ok: true, relation: next };
}

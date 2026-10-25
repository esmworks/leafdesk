import { searchFold } from "./search-fold";

/**
 * What the name typed for a new property says about its type (the "+" of a table, a row's "Add
 * property"): the types whose name (in the person's language) holds the text, those starting with
 * it first; none when the text is empty or names no type, so the full list stays.
 */
export function typesMatching<T extends string>(types: readonly T[], label: (type: T) => string, text: string): T[] {
  const q = searchFold(text.trim());
  if (!q) return [];
  const found = types.filter((type) => searchFold(label(type)).includes(q));
  const starts = found.filter((type) => searchFold(label(type)).startsWith(q));
  return [...starts, ...found.filter((type) => !starts.includes(type))];
}

/**
 * The name a new property of `type` gets from the text typed: the type's own name when the text is
 * empty or is just that name (in any case), else the text.
 */
export function newPropertyName<T extends string>(type: T, label: (type: T) => string, text: string): string {
  const name = text.trim();
  return !name || searchFold(name) === searchFold(label(type)) ? label(type) : name;
}

import { searchFold } from "./search-fold";

/**
 * Searching emoji and built-in icons by their names (the icon picker, the editor's ":" menu). Names
 * are "name|keyword|keyword" (public/emoji/names/<locale>.json, written by scripts/emoji-data.ts),
 * in the interface language and in English.
 */

/** Lowercased, without accents, as both sides are compared. */
export function foldName(text: string): string {
  return searchFold(text).normalize("NFD").replace(/\p{M}/gu, "");
}

/** What a name text is searched by: its folded words, the first name's first. */
export type NameIndex = { first: string; words: string[] };

export function indexNames(names: string): NameIndex {
  const parts = names.split("|").map(foldName);
  return { first: parts[0] ?? "", words: [...new Set(parts.flatMap((p) => [p, ...p.split(/[\s\-_:,.()]+/)]).filter(Boolean))] };
}

/**
 * How well `query` matches: 0 when the first name starts with it, 1 when every word of the query
 * starts a word of the first name, 2 when every word starts some name or word; null for no match.
 */
export function matchScore(index: NameIndex, query: string): number | null {
  const q = foldName(query).trim();
  if (!q) return null;
  if (index.first.startsWith(q)) return 0;
  const words = q.split(/\s+/);
  const firstWords = index.first.split(/[\s\-_:,.()]+/);
  if (words.every((w) => firstWords.some((f) => f.startsWith(w)))) return 1;
  if (words.every((w) => index.words.some((f) => f.startsWith(w)))) return 2;
  return null;
}

/** The items matching `query`, best first, in their own order within a score; at most `limit`. */
export function searchByNames<T>(items: readonly T[], indexOf: (item: T) => NameIndex | undefined, query: string, limit = 200): T[] {
  const scored: { item: T; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const index = indexOf(item);
    const score = index ? matchScore(index, query) : null;
    if (score !== null) scored.push({ item, score, at });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.item);
}

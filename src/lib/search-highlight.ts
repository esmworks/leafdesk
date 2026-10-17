import { CJK_RANGES } from "./search-words";

/**
 * The words of a search in a result's text, to show them marked: each found where the search
 * finds it, at the start of a word ("kond" in "Kondenser", not in "ikonda"), and Chinese or
 * Japanese anywhere in a run of their characters. Case doesn't count, nor which i (i, ı, I, İ).
 */
export type HighlightPart = { text: string; match: boolean };

const MAX_WORDS = 12;
const HAS_CJK = new RegExp(`[${CJK_RANGES}]`, "u");
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[iıIİ]/g, "[iıIİ]");

export function highlightParts(text: string, words: string[]): HighlightPart[] {
  const clean = [...new Set(words.map((w) => w.replace(/"/g, "").trim()).filter(Boolean))]
    .slice(0, MAX_WORDS)
    .sort((a, b) => b.length - a.length);
  if (!clean.length || !text) return [{ text, match: false }];
  const pattern = clean.map((w) => (HAS_CJK.test(w) ? escape(w) : `(?<![\\p{L}\\p{N}])${escape(w)}`)).join("|");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const found of text.matchAll(new RegExp(pattern, "giu"))) {
    if (!found[0]) continue;
    if (found.index > last) parts.push({ text: text.slice(last, found.index), match: false });
    parts.push({ text: found[0], match: true });
    last = found.index + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

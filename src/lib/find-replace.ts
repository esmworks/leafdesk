import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

/**
 * Find and replace in a page body: where a query occurs in a ProseMirror document, and the edits
 * that replace those occurrences. Pure functions over the document; the editor plugin
 * (components/page/find-replace.ts) keeps the state and draws the highlights.
 */

/** One occurrence, as document positions: the matched text is `doc.textBetween(from, to)`. */
export type FindMatch = { from: number; to: number };

export type FindOptions = {
  caseSensitive?: boolean;
  /**
   * Off (the default), letters match whatever accents they carry: "cafe" finds "café", "ç" pairs
   * with "c", "ş" with "s", "ı" with "i". On, an accented letter only matches itself.
   */
  matchAccents?: boolean;
  /** Case folding follows the reader's language: in Turkish "I" pairs with "ı" and "İ" with "i". */
  locale?: string;
};

/** Stands in for inline nodes that aren't text (mentions, line breaks), so matches never run across them. */
const OBJECT = "￼";

/**
 * What folding writes in place of a character the search skips: a combining accent written on its
 * own after its letter ("e" followed by U+0301), when accents don't matter. Keeping a character
 * there, instead of dropping it, keeps every index pointing at the same character. (A NUL in the
 * text itself is skipped the same way; pages don't hold them.)
 */
export const SKIPPED = "\u0000";

/**
 * Combining accents of Latin, Greek and Cyrillic letters. Marks other scripts spell with (kana
 * voicing marks, Indic vowel signs, Hebrew and Arabic vowel points) are left alone: there they make
 * a different letter rather than an accented one.
 */
const ACCENT = /[̀-ͯ᪰-᫿᷀-᷿︠-︯]/g;
const ACCENT_ONLY = /^[̀-ͯ᪰-᫿᷀-᷿︠-︯]$/;

/** Letters that read as another with an accent taken off, but that don't decompose into one. */
const BASE_LETTERS: Record<string, string> = {
  ı: "i",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  ł: "l",
  Ł: "L",
  ħ: "h",
  Ħ: "H",
};

/** One character lower-cased as `locale` does, in as many UTF-16 units as it had. */
function lowerChar(ch: string, locale: string | undefined): string {
  const lower = ch.toLocaleLowerCase(locale);
  // Only "İ" grows (to "i" and a combining dot); keeping the "i" is what a reader means by it.
  return lower.length === ch.length ? lower : lower.slice(0, ch.length);
}

/** One character without its accents, in as many UTF-16 units as it had; SKIPPED for an accent on its own. */
function baseChar(ch: string): string {
  if (ACCENT_ONLY.test(ch)) return SKIPPED;
  const listed = BASE_LETTERS[ch];
  if (listed) return listed;
  const base = ch.normalize("NFD").replace(ACCENT, "");
  // Anything that doesn't come apart into one letter and accents (Hangul, ligatures…) stays itself.
  return base.length === ch.length ? base : ch;
}

/**
 * Lower-cases `text` one character at a time so every index still points at the same character.
 * (Plain lower-casing can change the length: "İ" becomes "i" plus a combining dot outside Turkish.)
 */
export function foldCase(text: string, locale?: string): string {
  let out = "";
  for (const ch of text) out += lowerChar(ch, locale);
  return out;
}

/**
 * A folder for `options`: text as the search compares it, one character at a time and as long as
 * it was, so every index still points at the same character. Each distinct character is folded once.
 */
export function textFolder(options: FindOptions = {}): (text: string) => string {
  const { caseSensitive = false, matchAccents = false, locale } = options;
  if (caseSensitive && matchAccents) return (text) => text;
  const known = new Map<string, string>();
  const foldChar = (ch: string) => {
    let out = known.get(ch);
    if (out === undefined) {
      // Case first: in Turkish "I" lower-cases to "ı", which then reads as "i" when accents don't matter.
      out = caseSensitive ? ch : lowerChar(ch, locale);
      if (!matchAccents) out = baseChar(out);
      known.set(ch, out);
    }
    return out;
  };
  return (text) => {
    let out = "";
    for (const ch of text) out += foldChar(ch);
    return out;
  };
}

/**
 * Text as the search compares it (see textFolder): the same length, with SKIPPED in place of
 * accents written on their own when accents don't matter.
 */
export function foldForSearch(text: string, options: FindOptions = {}): string {
  return textFolder(options)(text);
}

/**
 * Where `needle` occurs in `haystack` (both folded), skipping SKIPPED characters on both sides, as
 * [start, end) index pairs that don't overlap. A match takes in the accents written after its last
 * letter, so replacing it leaves none behind.
 */
export function matchRanges(haystack: string, needle: string): [number, number][] {
  const wanted = needle.split(SKIPPED).join("");
  if (!wanted) return [];
  let compact = haystack;
  let at: number[] | null = null;
  if (haystack.includes(SKIPPED)) {
    compact = "";
    at = [];
    for (let i = 0; i < haystack.length; i++) {
      if (haystack[i] === SKIPPED) continue;
      compact += haystack[i];
      at.push(i);
    }
  }
  const ranges: [number, number][] = [];
  for (let i = compact.indexOf(wanted); i >= 0; i = compact.indexOf(wanted, i + wanted.length)) {
    const start = at ? at[i] : i;
    let end = (at ? at[i + wanted.length - 1] : i + wanted.length - 1) + 1;
    while (end < haystack.length && haystack[end] === SKIPPED) end++;
    ranges.push([start, end]);
  }
  return ranges;
}

/**
 * Every occurrence of `query` in the document, in document order. Each text block (paragraph,
 * heading, list item, table cell, code block…) is searched on its own, so a match never spans two
 * blocks; matches in one block don't overlap.
 */
export function findMatches(doc: PMNode, query: string, options: FindOptions = {}): FindMatch[] {
  if (!query || query.includes(OBJECT)) return [];
  const fold = textFolder(options);
  const needle = fold(query);
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text, with the document position of each character.
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? "";
        text += t;
        for (let i = 0; i < t.length; i++) at.push(start + i);
      } else {
        text += OBJECT;
        at.push(start);
      }
    });
    const haystack = fold(text);
    for (const [start, end] of matchRanges(haystack, needle)) matches.push({ from: at[start], to: at[end - 1] + 1 });
    return false;
  });
  return matches;
}

/** The match to start from at `pos`: the first one at or after it, else the first one; -1 when there are none. */
export function matchIndexAt(matches: readonly FindMatch[], pos: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

/** The next (or, with `step` -1, the previous) match, wrapping around the ends. */
export function stepIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * Replaces one match in `tr`. The new text takes the formatting (bold, link, comment…) of the
 * first matched character; an empty replacement deletes the match.
 */
export function replaceMatch(tr: Transaction, match: FindMatch, replacement: string): Transaction {
  if (!replacement) return tr.delete(match.from, match.to);
  const marks = tr.doc.resolve(match.from).nodeAfter?.marks ?? [];
  return tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(replacement, marks));
}

/**
 * Replaces every match in one transaction (one undo step). The matches must have been found in
 * `tr.doc`; they are replaced from the last to the first so the earlier positions stay valid.
 */
export function replaceAllMatches(tr: Transaction, matches: readonly FindMatch[], replacement: string): Transaction {
  const ordered = [...matches].sort((a, b) => b.from - a.from);
  for (const match of ordered) replaceMatch(tr, match, replacement);
  return tr;
}

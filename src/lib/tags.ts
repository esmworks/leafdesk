import { searchFold } from "./search-fold";

/**
 * `#tags` written in a page's text: plain text, found by this grammar wherever it is read (the
 * index, server/page-tags.ts; the editor's marks, components/page/tags.ts; the search box,
 * lib/search-query). Small and without other imports: the search box is in every first load.
 *
 * A tag is `#` at the start of the text or after whitespace or an opening bracket or quote,
 * followed by letters, digits, `_`, `-` and `/` (a hierarchy: `#home/renovation`). It holds at
 * least one letter (`#1` isn't one), starts with a letter, digit or `_`, and ends at anything
 * else; a `/` or `-` it ends with isn't part of it, and `//` ends it. A hex color with a digit in
 * it (`#ff0000`, `#1a2`) isn't one either.
 */

/** Longest tag, without the `#`: a longer run isn't a tag. */
export const MAX_TAG_LENGTH = 100;

/** What may stand right before a tag's `#`. */
const OPENER = /[\s\p{Ps}\p{Pi}"'¡¿]/u;
const BODY_START = /[\p{L}\p{M}\p{N}_]/u;
const BODY = /[\p{L}\p{M}\p{N}_\-/]/u;
const LETTER = /\p{L}/u;
const HEX_COLOR = /^(?=.*\d)(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export type FoundTag = {
  /** Where its `#` is, and where it ends (after its last character). */
  start: number;
  end: number;
  /** As written, without the `#`. */
  label: string;
  /** As tags are compared (tagKey). */
  key: string;
};

/**
 * Tags compare without case or accents: "Café", "cafe" and "CAFE" are one tag, as are the dotted
 * and dotless i (lib/search-fold).
 */
export function tagKey(label: string) {
  return searchFold(label.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC"));
}

/** The tag whose `#` is at `at` in `text`, or null when that `#` doesn't start one. */
export function tagAt(text: string, at: number): FoundTag | null {
  if (text.charAt(at) !== "#") return null;
  if (at > 0 && !OPENER.test(text.charAt(at - 1))) return null;
  let end = at + 1;
  while (end < text.length) {
    const char = String.fromCodePoint(text.codePointAt(end)!);
    if (end === at + 1 ? !BODY_START.test(char) : !BODY.test(char)) break;
    if (char === "/" && text.charAt(end + 1) === "/") break;
    end += char.length;
  }
  while (end > at + 1 && (text.charAt(end - 1) === "/" || text.charAt(end - 1) === "-")) end--;
  const label = text.slice(at + 1, end);
  if (!label || label.length > MAX_TAG_LENGTH || !LETTER.test(label) || HEX_COLOR.test(label)) return null;
  return { start: at, end, label, key: tagKey(label) };
}

/** Every tag in `text`, in order. */
export function findTags(text: string): FoundTag[] {
  const found: FoundTag[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("#", from);
    if (at === -1) return found;
    const tag = tagAt(text, at);
    if (tag) found.push(tag);
    from = tag ? tag.end : at + 1;
  }
}

/**
 * A tag as a search names it (`#home/renovation`, `tag:home`), without its `#`: the whole of
 * `value` must be one (a `/` or `-` at its end aside). Null when it isn't.
 */
export function searchedTag(value: string): FoundTag | null {
  const tag = tagAt(`#${value}`, 0);
  return tag && /^[-/]*$/.test(value.slice(tag.end - 1)) ? tag : null;
}

/**
 * The tag being typed at the end of `before` (the text before the caret): where its `#` is and
 * what follows it so far, a `/` or `-` at its end kept (`#home/` asks for the tags under `home`).
 * Null when the caret isn't at the end of a tag.
 */
export function typedTag(before: string): { start: number; query: string } | null {
  const at = before.lastIndexOf("#");
  if (at === -1 || before.length - at - 1 > MAX_TAG_LENGTH) return null;
  const tag = tagAt(before, at);
  if (!tag || !/^[-/]*$/.test(before.slice(tag.end)) || before.includes("//", tag.end - 1)) return null;
  return { start: at, query: before.slice(at + 1) };
}

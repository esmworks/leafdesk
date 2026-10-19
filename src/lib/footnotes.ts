/**
 * A footnote's note as it is shown in the list of notes: plain text, with the http(s) addresses in
 * it as links (a note often names its source). Nothing else in a note is read as markup.
 */

export type NotePart = { text: string } | { url: string };

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/g;
/** Punctuation that ends a sentence rather than the address before it. */
const TRAILING = ".,;:!?)]}'\"»”’";

/** The address without the punctuation after it; a closing parenthesis stays when it closes one in the address (Wikipedia's links). */
function trimAddress(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING.includes(url[end - 1])) {
    if (url[end - 1] === ")") {
      const inside = url.slice(0, end);
      const count = (char: string) => inside.split(char).length - 1;
      if (count("(") >= count(")")) break;
    }
    end--;
  }
  return url.slice(0, end);
}

export function noteParts(note: string): NotePart[] {
  const parts: NotePart[] = [];
  let last = 0;
  for (const match of note.matchAll(URL_IN_TEXT)) {
    const url = trimAddress(match[0]);
    if (!/^https?:\/\/[^/?#]/.test(url)) continue;
    if (match.index > last) parts.push({ text: note.slice(last, match.index) });
    parts.push({ url });
    last = match.index + url.length;
  }
  if (last < note.length) parts.push({ text: note.slice(last) });
  return parts;
}

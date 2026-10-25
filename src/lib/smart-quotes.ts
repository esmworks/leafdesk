/**
 * Typographic quotes for what is typed in a page (components/page/smart-quotes.ts): a straight
 * quote opens after the start of a line, a space, an opening bracket, dash or another opening
 * quote, and closes anywhere else, so `don't` gets an apostrophe. Pure.
 */

export type StraightQuote = '"' | "'";

const OPENS_AFTER = /[\s([{—–\-/“‘ ]$/u;

export const SMART_QUOTES = { '"': { open: "“", close: "”" }, "'": { open: "‘", close: "’" } } as const;

export function isStraightQuote(text: string): text is StraightQuote {
  return text === '"' || text === "'";
}

/** The quote to type for `quote` after `before` (the text of the line up to the cursor). */
export function smartQuote(before: string, quote: StraightQuote): string {
  const opening = before === "" || OPENS_AFTER.test(before);
  return opening ? SMART_QUOTES[quote].open : SMART_QUOTES[quote].close;
}

/**
 * The search box's query syntax (see components/sidebar/search-dialog and server/pages
 * searchPages): free words, plus filters anywhere in the query.
 *
 *   in:Projects            pages inside that page (and the page itself); a title with spaces in
 *   in:"Launch plan"       quotes. Several pages of that title: inside any of them
 *   type:page              plain pages, not database rows
 *   type:database          databases
 *   type:row               database rows
 *   type:journal           the user's daily notes
 *   is:verified            pages verified right now (server/verification), not those whose verification expired
 *
 * A filter's key and value are case-insensitive; an unknown key (`foo:bar`) or value
 * (`type:foo`) is searched as text. Text in double quotes ("launch plan") must appear as written,
 * its words whole and next to each other in that order (`phrases`); a quote not yet closed is searched as
 * words, so results don't vanish while the phrase is being typed.
 */

export type SearchKind = "page" | "database" | "row" | "journal";

export type SearchQuery = {
  /** The free text, filters removed. */
  text: string;
  /** Page titles from `in:` filters, as written. */
  within: string[];
  kinds: SearchKind[];
  /** `is:verified`: only pages verified right now. */
  verified: boolean;
  /** Text in closed double quotes: each must match as a phrase. Its words are in `text` too. */
  phrases: string[];
};

/** A piece of a query: `key:"quoted value"`, `"a phrase"` or a bare word. */
type Token = { kind: "quoted"; key: string; value: string } | { kind: "phrase"; text: string; closed: boolean } | { kind: "word"; text: string };

const SPACE = /\s/;
/** `key:"` at the start of a word; a key has no whitespace, colon or quote. */
const QUOTED_KEY = /^([^\s:"]+):"/;

/**
 * Splits a query into tokens in one forward scan (no regex over the whole query, so no
 * backtracking on long input). A quote runs to the next quote, spaces included, or to the end.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const quoteEnd = (from: number) => {
    const close = query.indexOf('"', from);
    return close === -1 ? query.length : close;
  };
  let index = 0;
  while (index < query.length) {
    if (SPACE.test(query.charAt(index))) {
      index++;
      continue;
    }
    if (query.charAt(index) === '"') {
      const end = quoteEnd(index + 1);
      tokens.push({ kind: "phrase", text: query.slice(index + 1, end), closed: end < query.length });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < query.length && !SPACE.test(query.charAt(end))) end++;
    const word = query.slice(index, end);
    const key = QUOTED_KEY.exec(word);
    if (key) {
      const valueStart = index + key[0].length;
      const valueEnd = quoteEnd(valueStart);
      tokens.push({ kind: "quoted", key: key[1], value: query.slice(valueStart, valueEnd) });
      index = valueEnd + 1;
      continue;
    }
    tokens.push({ kind: "word", text: word });
    index = end;
  }
  return tokens;
}

const KIND_NAMES: Record<string, SearchKind> = {
  page: "page",
  pages: "page",
  database: "database",
  databases: "database",
  db: "database",
  row: "row",
  rows: "row",
  journal: "journal",
  journals: "journal",
  daily: "journal",
};

/** Adds the filter `key:value` to `parsed`; false when it isn't one (then it's text). */
function applyFilter(parsed: SearchQuery, key: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (!value) return false;
  switch (key.toLowerCase()) {
    case "in":
      if (!parsed.within.some((title) => title.toLowerCase() === value.toLowerCase())) parsed.within.push(value);
      return true;
    case "type": {
      const kind = KIND_NAMES[value.toLowerCase()];
      if (!kind) return false;
      if (!parsed.kinds.includes(kind)) parsed.kinds.push(kind);
      return true;
    }
    case "is":
      if (value.toLowerCase() !== "verified") return false;
      parsed.verified = true;
      return true;
    default:
      return false;
  }
}

/** Splits a query into its free text and its filters. */
export function parseSearchQuery(query: string): SearchQuery {
  const parsed: SearchQuery = { text: "", within: [], kinds: [], verified: false, phrases: [] };
  const words: string[] = [];
  for (const token of tokenize(query)) {
    if (token.kind === "quoted") {
      if (!applyFilter(parsed, token.key, token.value)) words.push(token.value);
    } else if (token.kind === "phrase") {
      words.push(token.text);
      const phrase = token.text.replace(/\s+/g, " ").trim();
      // One quoted word is a phrase too: found whole, not as the start of a longer word.
      if (token.closed && /[\p{L}\p{N}]/u.test(phrase) && !parsed.phrases.includes(phrase)) parsed.phrases.push(phrase);
    } else {
      const colon = token.text.indexOf(":");
      if (colon > 0 && applyFilter(parsed, token.text.slice(0, colon), token.text.slice(colon + 1))) continue;
      words.push(token.text);
    }
  }
  parsed.text = words.join(" ").replace(/\s+/g, " ").trim();
  return parsed;
}

/** Whether the query has a filter (then it lists pages even without text). */
export const hasSearchFilters = (parsed: SearchQuery) => parsed.within.length > 0 || parsed.kinds.length > 0 || parsed.verified;

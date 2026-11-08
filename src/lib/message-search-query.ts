/**
 * What is typed into Messages' search, read into the server's search (server/messages/search.ts):
 * words and "quoted phrases" stay words; `from:` names a person (`from:me`, `from:@ann`,
 * `from:"Ann Lee"`), `in:` a channel (`in:#design`), `has:` what a message carries (file, image,
 * link, pin, reaction, thread), `before:`, `after:` and `on:` a day (YYYY-MM-DD). A filter whose
 * name or channel isn't known stays in the words, so nothing typed is silently dropped. No imports:
 * the box reads it in the first load of the page.
 */

export const SEARCH_HAS = ["file", "image", "link", "pin", "reaction", "thread"] as const;
export type SearchHas = (typeof SEARCH_HAS)[number];

export type MessageSearchInput = { query: string; from: string[]; in: string[]; has: SearchHas[]; after: string | null; before: string | null };

type Resolve = {
  /** A person's id by what was typed after `from:` (without `@`), or null. */
  person: (name: string) => string | null;
  /** A channel's id by what was typed after `in:` (without `#`), or null. */
  channel: (name: string) => string | null;
};

const TOKEN = /(\S+?):("([^"]*)"|\S+)|"[^"]*"|\S+/g;

function day(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

export function parseMessageSearch(text: string, resolve: Resolve): MessageSearchInput {
  const out: MessageSearchInput = { query: "", from: [], in: [], has: [], after: null, before: null };
  const words: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const [whole, key, raw, quoted] = match;
    if (!key) {
      words.push(whole);
      continue;
    }
    const value = quoted ?? raw;
    const name = key.toLowerCase();
    if (name === "from") {
      const id = resolve.person(value.replace(/^@/, ""));
      if (id) {
        out.from.push(id);
        continue;
      }
    } else if (name === "in") {
      const id = resolve.channel(value.replace(/^#/, ""));
      if (id) {
        out.in.push(id);
        continue;
      }
    } else if (name === "has") {
      const what = value.toLowerCase();
      if ((SEARCH_HAS as readonly string[]).includes(what)) {
        if (!out.has.includes(what as SearchHas)) out.has.push(what as SearchHas);
        continue;
      }
    } else if (name === "before" || name === "after" || name === "on") {
      const d = day(value);
      if (d) {
        if (name === "after") out.after = d.toISOString();
        else if (name === "before") out.before = d.toISOString();
        else {
          out.after = d.toISOString();
          const next = new Date(d);
          next.setDate(d.getDate() + 1);
          out.before = next.toISOString();
        }
        continue;
      }
    }
    words.push(whole);
  }
  out.query = words.join(" ").trim();
  return out;
}

/** Whether the search asks for anything (the server refuses an empty one). */
export const searchAsks = (s: MessageSearchInput) => !!(s.query || s.from.length || s.in.length || s.has.length || s.after || s.before);

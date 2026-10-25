import { dateFrom, fold, isGlued, languagesFor, readAs, tokenize, type Found } from "@/lib/date-words";
import { dayNumber, dayString } from "@/lib/time-zone";

/**
 * Quick add: a new row's title typed with its date, people and options in it ("Send the offer
 * friday @Ayşe #urgent"). The parts it recognises come out of the title and go to the row's
 * properties; the rest stays the title. Words are understood in the interface language and in
 * English. Nothing here knows about databases: the caller passes the people and the options that
 * may be named, and applies the result.
 */

type QuickAddPerson = { id: string; name: string };
export type QuickAddOption = { propertyId: string; optionId: string; name: string };
type QuickAddMatchKind = "date" | "person" | "option";
/** A recognised part of the text, `start`–`end` in it. */
export type QuickAddMatch = { kind: QuickAddMatchKind; start: number; end: number; text: string };

export type QuickAddContext = {
  /** The interface language ("tr", "en"...). */
  locale: string;
  /** Today in the person's time zone, YYYY-MM-DD. */
  today: string;
  people?: QuickAddPerson[];
  options?: QuickAddOption[];
  /** Recognised texts (as written) the person chose to keep in the title. */
  ignored?: ReadonlySet<string>;
  /** False when there is nowhere to put a date: dates stay in the title. */
  dates?: boolean;
};

export type QuickAddResult = {
  title: string;
  /** YYYY-MM-DD. */
  date: string | null;
  people: string[];
  options: QuickAddOption[];
  matches: QuickAddMatch[];
};

// Each person's or option's name and first word, folded: worked out once, not on every keystroke.
const foldedNames = new WeakMap<object, string[]>();
function foldedNamesOf(item: { name: string }): string[] {
  let names = foldedNames.get(item);
  if (!names) foldedNames.set(item, (names = [item.name, item.name.split(" ")[0]].map((name) => fold(name.trim()))));
  return names;
}

/** The longest name in `names` the text at `from` starts with, ending at a word boundary. */
function nameAt<T extends { name: string }>(text: string, from: number, names: T[], dashes: boolean): { item: T; end: number } | null {
  const rest = fold(text.slice(from));
  const normalized = dashes ? rest.replace(/[-_]/g, " ") : rest;
  let best: { item: T; end: number } | null = null;
  for (const item of names) {
    for (const folded of foldedNamesOf(item)) {
      if (!folded || !normalized.startsWith(dashes ? folded.replace(/[-_]/g, " ") : folded)) continue;
      const after = normalized.charAt(folded.length);
      if (after && !/[\s,;.!?)]/.test(after)) continue;
      if (!best || folded.length > best.end - from) best = { item, end: from + folded.length };
    }
  }
  return best;
}

export function parseQuickAdd(text: string, context: QuickAddContext): QuickAddResult {
  const today = dayNumber(context.today);
  const tokens = tokenize(text, isGlued(context.locale));
  const readings = languagesFor(context.locale).map((lang) => ({ lang, tokens: readAs(tokens, lang) }));
  const matches: QuickAddMatch[] = [];
  const people: string[] = [];
  const options: QuickAddOption[] = [];
  let date: number | null = null;
  const ignored = context.ignored ?? new Set<string>();

  const take = (kind: QuickAddMatchKind, start: number, end: number) => {
    const written = text.slice(start, end);
    if (ignored.has(written)) return false;
    matches.push({ kind, start, end, text: written });
    return true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const sigil = text.charAt(token.start);
    const named =
      sigil === "@"
        ? nameAt(text, token.start + 1, context.people ?? [], false)
        : sigil === "#"
          ? nameAt(text, token.start + 1, context.options ?? [], true)
          : null;
    if (named && take(sigil === "@" ? "person" : "option", token.start, named.end)) {
      const item = named.item;
      if ("id" in item) {
        if (!people.includes(item.id)) people.push(item.id);
      } else if (!options.some((o) => o.propertyId === item.propertyId && o.optionId === item.optionId)) {
        options.push(item);
      }
      while (i + 1 < tokens.length && tokens[i + 1].start < named.end) i++;
      continue;
    }
    const dated: Found | null | undefined =
      date === null && context.dates !== false ? readings.map((r) => dateFrom(r.tokens, i, r.lang, today)).find(Boolean) : null;
    if (dated && take("date", token.start, tokens[i + dated.length - 1].end)) {
      date = dated.day;
      i += dated.length - 1;
    }
  }

  let title = "";
  let at = 0;
  for (const match of matches) {
    title += text.slice(at, match.start);
    at = match.end;
  }
  title += text.slice(at);
  title = title.replace(/\s+/g, " ").replace(/\s+([,;.!?])/g, "$1").replace(/^[\s,;、，]+|[\s,;、，]+$/g, "");

  return {
    title,
    date: date === null ? null : dayString(date),
    people,
    options,
    matches,
  };
}

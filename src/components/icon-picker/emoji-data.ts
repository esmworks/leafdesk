import { indexNames, searchByNames, type NameIndex } from "@/lib/emoji-search";

/**
 * The emoji the icon picker and the editor's ":" menu offer (public/emoji/, written by
 * scripts/emoji-data.ts): by category, with their five skin tones where they have them, and their
 * names in the interface language and in English. Fetched once per language, when first needed.
 */

export type EmojiEntry = { emoji: string; tones: readonly string[] | null };
export type EmojiCategory = { key: string; emoji: EmojiEntry[] };
export type EmojiData = {
  categories: EmojiCategory[];
  all: EmojiEntry[];
  /** By emoji: its names, for search. */
  names: Map<string, NameIndex>;
  /** By emoji: its name in the interface language, for a tooltip. */
  labels: Map<string, string>;
};

const loads = new Map<string, Promise<EmojiData>>();

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export function loadEmojiData(locale: string): Promise<EmojiData> {
  let load = loads.get(locale);
  if (!load) {
    load = (async () => {
      const [raw, local, english] = await Promise.all([
        json<{ key: string; emoji: (string | string[])[] }[]>("/emoji/emoji.json"),
        json<Record<string, string>>(`/emoji/names/${encodeURIComponent(locale)}.json`).catch(() => ({}) as Record<string, string>),
        locale === "en" ? Promise.resolve(null) : json<Record<string, string>>("/emoji/names/en.json"),
      ]);
      const categories = raw.map((c) => ({
        key: c.key,
        emoji: c.emoji.map((e) => (typeof e === "string" ? { emoji: e, tones: null } : { emoji: e[0], tones: e.slice(1) })),
      }));
      const all = categories.flatMap((c) => c.emoji);
      const names = new Map<string, NameIndex>();
      const labels = new Map<string, string>();
      for (const { emoji } of all) {
        const own = local[emoji] ?? "";
        const en = english?.[emoji] ?? "";
        names.set(emoji, indexNames([own, en].filter(Boolean).join("|")));
        labels.set(emoji, (own || en).split("|")[0]);
      }
      return { categories, all, names, labels };
    })();
    // A failed load is tried again next time.
    load.catch(() => loads.delete(locale));
    loads.set(locale, load);
  }
  return load;
}

/** `entry` in the person's skin tone (1 to 5), where it has tones. */
export function withTone(entry: EmojiEntry, tone: number | null): string {
  return tone && entry.tones?.[tone - 1] ? entry.tones[tone - 1] : entry.emoji;
}

export function searchEmoji(data: EmojiData, query: string, limit = 200): EmojiEntry[] {
  return searchByNames(data.all, (e) => data.names.get(e.emoji), query, limit);
}

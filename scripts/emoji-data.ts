// Writes the icon picker's emoji (public/emoji/): which emoji there are, by category, with their
// skin tones (emoji.json), and their names and keywords in each interface language
// (names/<locale>.json), which the picker's search and the editor's ":" menu look through.
//
//   pnpm tsx scripts/emoji-data.ts
//
// The emoji, categories, tones and English names come from emojibase-data (a dev dependency);
// the other languages' names from Unicode CLDR's annotations (cldr-annotations-full and
// cldr-annotations-derived-full, fetched from the npm CDN at CLDR_VERSION). Emoji newer than
// MAX_EMOJI_VERSION are left out: many systems don't draw them yet.
export {};

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "../src/i18n/config";

const CLDR_VERSION = "47.0.0";
const MAX_EMOJI_VERSION = 15.1;

type Emoji = {
  emoji: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  version: number;
  tone?: number | number[];
  skins?: Emoji[];
};

const root = process.cwd();
const data = JSON.parse(readFileSync(join(root, "node_modules/emojibase-data/en/data.json"), "utf8")) as Emoji[];
const groups = (JSON.parse(readFileSync(join(root, "node_modules/emojibase-data/en/messages.json"), "utf8")) as { groups: { key: string; order: number }[] }).groups;

/** Without variation selectors, as CLDR writes most emoji. */
const bare = (emoji: string) => emoji.replaceAll("️", "");

// The categories in order, without "component" (skin tones and hair alone).
const shown = data
  .filter((e) => e.group !== undefined && e.group !== 2 && e.version <= MAX_EMOJI_VERSION)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const categories = groups
  .filter((g) => g.key !== "component")
  .map((g) => ({
    key: g.key,
    emoji: shown
      .filter((e) => e.group === g.order)
      .map((e) => {
        // Five tones, one per modifier; for people together, the five where all have the same tone.
        const tones = (e.skins ?? []).filter((s) => s.version <= MAX_EMOJI_VERSION && (typeof s.tone === "number" || new Set(s.tone).size === 1));
        return tones.length === 5 ? [e.emoji, ...tones.map((s) => s.emoji)] : e.emoji;
      }),
  }));
const out = join(root, "public/emoji");
mkdirSync(join(out, "names"), { recursive: true });
writeFileSync(join(out, "emoji.json"), JSON.stringify(categories));

/** "name|keyword|keyword", lowercased, without repeats. */
const entry = (label: string, tags: string[]) => [...new Set([label, ...tags].map((w) => w.toLocaleLowerCase().replaceAll("|", " ").trim()).filter(Boolean))].join("|");

const english: Record<string, string> = {};
for (const e of shown) english[e.emoji] = entry(e.label, e.tags ?? []);
writeFileSync(join(out, "names/en.json"), JSON.stringify(english));

type Annotations = Record<string, { default?: string[]; tts?: string[] }>;
async function annotations(pkg: string, folder: string, locale: string): Promise<Annotations> {
  const url = `https://cdn.jsdelivr.net/npm/${pkg}@${CLDR_VERSION}/${folder}/${locale}/annotations.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const json = (await response.json()) as Record<string, { annotations: Annotations }>;
  return Object.values(json)[0].annotations;
}

for (const locale of LOCALES) {
  if (locale === "en") continue;
  // CLDR files Norwegian Bokmål under "no".
  const cldr = locale === "nb" ? "no" : locale;
  const found = {
    ...(await annotations("cldr-annotations-derived-full", "annotationsDerived", cldr)),
    ...(await annotations("cldr-annotations-full", "annotations", cldr)),
  };
  const byBare = new Map(Object.entries(found).map(([emoji, a]) => [bare(emoji), a]));
  const names: Record<string, string> = {};
  let missing = 0;
  for (const e of shown) {
    const a = byBare.get(bare(e.emoji));
    if (!a?.tts?.[0]) {
      missing++;
      continue;
    }
    names[e.emoji] = entry(a.tts[0], a.default ?? []);
  }
  writeFileSync(join(out, `names/${locale}.json`), JSON.stringify(names));
  console.log(`${locale}: ${Object.keys(names).length} named, ${missing} only in English`);
}
console.log(`${shown.length} emoji in ${categories.length} categories`);
process.exit(0);

// Writes src/lib/import/slack-emoji.ts: the emoji a chat export's reaction names stand for
// (`thumbsup`, `+1`, `white_check_mark`), so imported reactions are the same characters the
// emoji picker sends. The names are Slack's own set (emojibase-data's iamcal shortcodes), the
// characters emojibase-data's, as public/emoji/ has them (scripts/emoji-data.ts).
//
//   pnpm tsx scripts/slack-emoji.ts
export {};

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Emoji = { emoji: string; hexcode: string; skins?: Emoji[] };

const root = process.cwd();
const data = JSON.parse(readFileSync(join(root, "node_modules/emojibase-data/en/data.json"), "utf8")) as Emoji[];
const names = JSON.parse(readFileSync(join(root, "node_modules/emojibase-data/en/shortcodes/iamcal.json"), "utf8")) as Record<string, string | string[]>;

const byHex = new Map<string, string>();
for (const e of data) {
  byHex.set(e.hexcode, e.emoji);
  for (const s of e.skins ?? []) byHex.set(s.hexcode, s.emoji);
}

const map: Record<string, string> = {};
for (const [hex, value] of Object.entries(names)) {
  const emoji = byHex.get(hex);
  if (!emoji) continue;
  // Skin tones are written after the name in an export (`thumbsup::skin-tone-3`): only the bases here.
  if (/-1F3F[B-F]/.test(hex)) continue;
  for (const name of Array.isArray(value) ? value : [value]) if (!(name in map)) map[name] = emoji;
}
const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const out = `// Written by scripts/slack-emoji.ts; don't edit by hand.

/** A chat export's reaction names and the emoji each stands for (skin tones come after the name: lib/import/slack.ts). */
export const SLACK_EMOJI: Readonly<Record<string, string>> = ${JSON.stringify(sorted)};
`;
writeFileSync(join(root, "src/lib/import/slack-emoji.ts"), out);
console.log(`${Object.keys(sorted).length} names`);

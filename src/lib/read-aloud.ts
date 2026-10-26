/**
 * Reading a page aloud with the browser's own speech (components/page/read-aloud.tsx): nothing is
 * sent anywhere. The pure parts: how a block's text is cut into utterances, which voice reads by
 * default, and the speeds offered.
 */

/** Speeds the player offers; 1 is the voice's own. */
export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Longest utterance handed to the browser. Some browsers stop a long utterance after about 15
 * seconds, and short ones let pause and the next block react quickly.
 */
export const MAX_UTTERANCE = 240;

/**
 * `text` cut into pieces of at most `max` characters, at sentence ends where it can, else at a
 * comma or semicolon, else at a space, and only as a last resort inside a word. Whitespace runs
 * become one space; empty text gives no pieces.
 */
export function splitForSpeech(text: string, max = MAX_UTTERANCE): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const cut = lastBreak(head, /[.!?…](?=\s)|[。！？]/g) ?? lastBreak(head, /[,;:،](?=\s)|[、，；]/g) ?? lastBreak(head, /\s/g, 0) ?? max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Where to cut `text` (one character longer than a piece may be) at the last match of `pattern`
 * past its first quarter: just after the match (`after`), or where it starts. Null without one.
 */
function lastBreak(text: string, pattern: RegExp, after = 1): number | null {
  let found: number | null = null;
  for (const m of text.matchAll(pattern)) {
    const cut = after ? m.index + m[0].length : m.index;
    if (m.index >= text.length / 4 && cut < text.length) found = cut;
  }
  return found === 0 ? null : found;
}

type VoiceLike = { voiceURI: string; lang: string; default: boolean; localService?: boolean };

/**
 * The voice to read with: the one chosen before (by its URI), else the best match for `lang` (the
 * same language and region, then the same language, a voice on the device first), else the
 * browser's default, else the first. Null without voices.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string, chosen?: string | null): V | null {
  if (!voices.length) return null;
  if (chosen) {
    const found = voices.find((v) => v.voiceURI === chosen);
    if (found) return found;
  }
  const want = lang.toLowerCase().replace("_", "-");
  const base = want.split("-")[0];
  const norm = (v: V) => v.lang.toLowerCase().replace("_", "-");
  const local = (list: V[]) => list.find((v) => v.localService) ?? list.find((v) => v.default) ?? list[0];
  const exact = voices.filter((v) => norm(v) === want);
  if (exact.length) return local(exact);
  const sameLanguage = voices.filter((v) => norm(v).split("-")[0] === base);
  if (sameLanguage.length) return local(sameLanguage);
  return voices.find((v) => v.default) ?? voices[0];
}

/** A stored speed as one of READ_ALOUD_RATES, 1 otherwise. */
export function parseRate(value: unknown): number {
  const n = Number(value);
  return (READ_ALOUD_RATES as readonly number[]).includes(n) ? n : 1;
}

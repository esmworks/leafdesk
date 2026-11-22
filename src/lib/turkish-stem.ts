/**
 * The roots a Turkish word may have under one case, possessive or plural ending, for searches that
 * match the start of words: "farkı" finds a note saying "fark", "notlar" one saying "not", and
 * "kitabı", "örneği" ones saying "kitap", "örnek" (a root's last b, c, d or ğ turns back into p,
 * ç, t or k once the ending goes). A search by a word's start already finds longer words
 * ("fark" finds "farkı"); this is the other way round, a word with an ending finding its root.
 *
 * A rough cut without a dictionary: it takes off one ending, longest first, and keeps a root of at
 * least four letters (three for a plural), so short words stay as they are. Some English words
 * lose a few letters too ("dollar" → "dol"); a caller weighs a match by a root below one by the
 * word itself. Words are lower-cased with the Turkish rules ("İ" → "i", "I" → "ı") beforehand.
 */

/** Endings, longest first, each with the shortest root it may leave. */
const ENDINGS: readonly (readonly [string, number])[] = [
  ...["lerinden", "larından", "lerinde", "larında", "lerine", "larına", "lerini", "larını", "lerin", "ların"].map((e) => [e, 3] as const),
  ...["leri", "ları", "ler", "lar"].map((e) => [e, 3] as const),
  ...["ndan", "nden", "nın", "nin", "nun", "nün", "dan", "den", "tan", "ten", "nda", "nde"].map((e) => [e, 4] as const),
  ...["da", "de", "ta", "te", "ın", "in", "un", "ün", "nı", "ni", "nu", "nü", "na", "ne", "ya", "ye", "yı", "yi", "yu", "yü", "sı", "si", "su", "sü"].map(
    (e) => [e, 4] as const,
  ),
  ...["ı", "i", "u", "ü"].map((e) => [e, 4] as const),
];

const SOFTENED: Readonly<Record<string, string>> = { b: "p", c: "ç", d: "t", ğ: "k" };

/** The roots of `word` (lower-cased), not the word itself; none when no ending comes off. */
export function turkishRoots(word: string): string[] {
  const letters = Array.from(word);
  for (const [ending, shortest] of ENDINGS) {
    if (!word.endsWith(ending)) continue;
    const root = letters.slice(0, letters.length - Array.from(ending).length);
    if (root.length < shortest) continue;
    const last = root[root.length - 1];
    const hard = SOFTENED[last];
    return hard ? [root.join(""), [...root.slice(0, -1), hard].join("")] : [root.join("")];
  }
  return [];
}

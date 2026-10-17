// Search terms for "any of these words", which the AI chat uses: it searches with whole questions
// ("Kart ekstreleri ne durumda?"), where requiring every word finds nothing.

/** Question words and fillers that would match almost any page (Turkish and English). */
const STOPWORDS = new Set(
  (
    "acaba ama bana beni benim bir biraz bize bizim bu bunu bunun çok daha diye gibi hangi hangisi hem için ile ise kaç kadar " +
    "mı mi mu mü nasıl ne neden nedir nerede neler niye olan olarak oldu olur sadece şu var veya yok " +
    "about and are can did does for from has have how into its many much should that the their them there " +
    "these this was what when where which who why will with would you your"
  ).split(" "),
);

/** Longer words are cut to this many letters and matched as prefixes (a rough stem for suffixes). */
const STEM = 5;
const STEM_FROM = 7;
const MAX_TERMS = 12;

/**
 * Japanese kana, Chinese characters and Korean Hangul: written without spaces between words, or
 * with particles joined to them ("会議について", "회의를"), so the text-search parser takes a whole
 * run as one word and finds it only from its start. The search index also holds every
 * two-character piece of such text (cjk_bigrams in drizzle/0077_cjk_search.sql, with the same
 * ranges), and queries are cut into the same pieces.
 */
const CJK = "\\u3005\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af";
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
const CJK_PARTS = new RegExp(`([${CJK}]+)`, "u");
const IS_CJK = new RegExp(`^[${CJK}]+$`, "u");

/** The two-character pieces of a run, in order ("会議中" → 会議, 議中); a single character stays itself. */
function bigrams(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length < 2) return chars;
  return chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
}

/**
 * `query` as the text-search parser should read it: each run of Japanese, Chinese or Korean
 * characters becomes its two-character pieces ("明日の会議" → "明日 日の の会 会議"). Required
 * together, the pieces find the run anywhere in a page, also inside a longer sentence. Other text
 * is left as it is.
 */
export function searchQueryText(query: string): string {
  return query.replace(CJK_RUN, (run) => ` ${bigrams(run).join(" ")} `).trim();
}

/**
 * Pieces of a question that say nothing about what is asked: with hiragana, which Japanese writes
 * particles and endings in ("の会", "つい", "いて"), or a Chinese function word ("的会").
 */
const FILLER = /[぀-ゟ的了是在吗呢吧啊么哪这那我你他她它们和与或也都就]/u;

/**
 * The words of `query` worth searching for: letters and digits only (so nothing else reaches the
 * text-search query), at least 3 characters, no stopwords, each once, long ones cut to their first
 * five letters ("ekstreleri" → "ekstr", matching "ekstresi" too). Japanese, Chinese and Korean text
 * gives its two-character pieces instead, without the ones that hold particles or function words. Case is left to the database, so Turkish İ and I are lowered there the same way as the
 * text. Empty when no word is left.
 */
export function anyWordTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (term: string) => {
    const termKey = term.toLocaleLowerCase("tr");
    if (seen.has(termKey)) return;
    seen.add(termKey);
    terms.push(term);
  };
  for (const word of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const part of word.split(CJK_PARTS)) {
      if (terms.length === MAX_TERMS) return terms;
      if (!part) continue;
      if (IS_CJK.test(part)) {
        if (Array.from(part).length < 2) continue;
        const pieces = bigrams(part);
        // A word written in hiragana alone keeps its pieces.
        const telling = pieces.filter((piece) => !FILLER.test(piece));
        for (const piece of telling.length ? telling : pieces) if (terms.length < MAX_TERMS) add(piece);
        continue;
      }
      const letters = Array.from(part);
      if (letters.length < 3) continue;
      const key = part.toLocaleLowerCase("tr");
      if (STOPWORDS.has(key) || STOPWORDS.has(part.toLowerCase())) continue;
      add(letters.length >= STEM_FROM ? letters.slice(0, STEM).join("") : part);
    }
  }
  return terms;
}

/** Whether a search term is a piece of Japanese, Chinese or Korean text, found inside words rather than at their start. */
export function isCjkTerm(term: string): boolean {
  return IS_CJK.test(term);
}

/** A `to_tsquery` text matching pages with any of the terms, as prefixes. */
export function anyWordTsQuery(terms: string[]): string {
  return terms.map((t) => `${t}:*`).join(" | ");
}

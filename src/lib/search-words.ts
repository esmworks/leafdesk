// Search terms for "any of these words", which the AI chat uses: it searches with whole questions
// ("Kart ekstreleri ne durumda?"), where requiring every word finds nothing.

/**
 * Question words and fillers that would match almost any page, in the interface's languages (words
 * shorter than three letters are left out anyway). Words that mean something in another of them
 * are kept out: Spanish and Portuguese "para" is Turkish for money.
 */
const STOPWORDS = new Set(
  (
    "acaba ama bana beni benim bir biraz bize bizim bu bunu bunun çok daha diye gibi hangi hangisi hem için ile ise kaç kadar " +
    "mı mi mu mü nasıl ne neden nedir nerede neler niye olan olarak oldu olur sadece şu var veya yok " +
    "about and are can did does for from has have how into its many much should that the their them there " +
    "these this was what when where which who why will with would you your " +
    // German, Spanish, French, Italian, Portuguese, Polish
    "aber alle als auch bei das dem den der des die dies diese dieser doch ein eine einem einen einer eines für gibt habe " +
    "haben hat ich ist mit nach nicht noch oder sich sie sind und uns von welche welcher welches wenn wer wie wir wird zum zur über " +
    "algo como con cual cuál cuales cuándo cuando del donde dónde ella ellos esa ese esta este esto están está hay las los más " +
    "muy nos pero por qué que quien quién sobre sus tiene una uno unos " +
    "aux avec ces comment dans elle être leur les mais mes nous pour quand quel quelle quels qui sont sur vous ont " +
    "che chi come cosa dei della delle dello dove gli hai per perché quale quali questo questa sono sul sulla " +
    "com das dos ela essa esse isso pela pelo qual quais quem são sem tem umas uns você onde " +
    "albo ale ani być czy dla gdzie jak jaki jakie jaka jest kiedy kto mam może nie oraz się tego tej też tym " +
    // Russian, Ukrainian, Arabic, Hebrew, Persian
    "был были где для его есть как когда кто или них она они под при про что это эти этот чем мне нас вас вот " +
    "або але його мене вони вона все які яка який коли хто щоб цей цього там тут " +
    "ماذا متى أين كيف لماذا هذا هذه ذلك التي الذي على إلى كان كانت ليس " +
    "מתי איפה איך למה האם זאת אני הוא היא אין " +
    "چرا کجا چطور آیا این برای است هست نیست " +
    // Korean, as cut by koreanStem: 어디에 → 어디, 있어요 → 있어.
    "어디 무엇 언제 누가 누구 어떻 어떤 어느 무슨 있어 있나 있는 있습 없어 없나 입니 합니 해요 하는 그리 이거 그거 저거"
  ).split(" "),
);

/** Longer words are cut to this many letters and matched as prefixes (a rough stem for suffixes). */
const STEM = 5;
const STEM_FROM = 7;
const MAX_TERMS = 12;

/**
 * Chinese characters and Japanese kana: written without spaces between words, so the text-search
 * parser takes a whole run as one word and finds it only from its start. The search index also
 * holds every two-character piece of such text (cjk_bigrams in drizzle/0077_cjk_search.sql, with
 * the same ranges: search-words.test.ts compares them), and queries are cut into the same pieces.
 * Letters only, no punctuation such as ・. Korean is written with spaces and its particles joined
 * to the end of a word (회의를), so it is searched like other languages, by the start of words.
 * Changing these ranges needs a migration that rebuilds page.search_vector: replacing the function
 * alone doesn't recompute the stored vectors.
 */
const HAN = "\\u3005-\\u3007\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{2fa1f}";
const HIRAGANA = "\\u3041-\\u3096\\u309d-\\u309f";
const KATAKANA = "\\u30a1-\\u30fa\\u30fc-\\u30ff\\uff66-\\uff9f";
export const CJK_RANGES = HAN + HIRAGANA + KATAKANA;
const CJK_RUN = new RegExp(`[${CJK_RANGES}]+`, "gu");
const CJK_PARTS = new RegExp(`([${CJK_RANGES}]+)`, "u");
const IS_CJK = new RegExp(`^[${CJK_RANGES}]+$`, "u");
const IS_HAN = new RegExp(`^[${HAN}]$`, "u");
const IS_HIRAGANA = new RegExp(`^[${HIRAGANA}]$`, "u");
const IS_KATAKANA = new RegExp(`^[${KATAKANA}]$`, "u");
const ALL_HIRAGANA = new RegExp(`^[${HIRAGANA}]+$`, "u");
const KANA = new RegExp(`[${HIRAGANA}${KATAKANA}]`, "u");

/**
 * Chinese words that say nothing about what is asked: question words, pronouns, particles. Single
 * characters that also start common Japanese words (都, 和, 有, 他) aren't among them.
 */
const FUNCTION_WORDS = "为什么 有没有 什么 怎么 怎样 哪里 哪儿 哪个 哪些 多少 我们 你们 他们 她们 它们 这个 那个 这些 那些 是否 可以 已经 没有"
  .split(" ")
  .sort((a, b) => b.length - a.length);
const FUNCTION_CHARS = "的了是在吗呢吧啊么哪这那我你她它们或也就";

/** Which kind of Japanese or Chinese character `char` is, or null for any other. */
export function cjkScript(char: string): "han" | "hiragana" | "katakana" | null {
  if (IS_HAN.test(char)) return "han";
  if (IS_HIRAGANA.test(char)) return "hiragana";
  if (IS_KATAKANA.test(char)) return "katakana";
  return null;
}

/** Whether `text` has Japanese kana, so its Chinese characters are read as Japanese. */
export function hasKana(text: string): boolean {
  return KANA.test(text);
}

/** Whether `char` is a Chinese function word of one character (的, 了, 在…). */
export function isFunctionChar(char: string): boolean {
  return [...char].length === 1 && FUNCTION_CHARS.includes(char);
}

/** The two-character pieces of a run, in order ("会議中" → 会議, 議中); a single character stays itself. */
function bigrams(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length < 2) return chars;
  return chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
}

/** A piece with hiragana (particles and endings: の会) or a Chinese function word (的会). */
const isFiller = (piece: string) => [...piece].some((char) => IS_HIRAGANA.test(char) || isFunctionChar(char));

/**
 * A `to_tsquery` text that finds a run of Chinese or Japanese characters where it is written, also
 * inside a longer sentence: a single character as the start of a piece (会:* finds 会議), else its
 * two-character pieces. Pieces of one word must stand next to each other (東京都 → 東京 <-> 京都, so
 * a page about 東京 and 京都 doesn't match); pieces with particles or function words are only
 * required (明日の会議 → 明日 & 日の & の会 & 会議): they are common, and the index keeps no more
 * than 256 places of a piece, which a phrase would need. Places also stop at about 16,000 words and
 * pieces into a page, so a word of three or more characters written further into a very long page
 * may not be found. The run holds only those characters, none with a meaning in a query.
 */
export function cjkTsQuery(run: string): string {
  if (Array.from(run).length === 1) return `${run}:*`;
  const items: string[] = [];
  let chain: string[] = [];
  const flush = () => {
    if (chain.length) items.push(chain.length > 1 ? `(${chain.join(" <-> ")})` : chain[0]);
    chain = [];
  };
  for (const piece of bigrams(run)) {
    if (isFiller(piece)) {
      flush();
      items.push(piece);
    } else chain.push(piece);
  }
  flush();
  return items.length > 1 ? `(${items.join(" & ")})` : items[0];
}

/**
 * `query` split for the text search: `words`, the text without its Chinese and Japanese runs, for
 * the parser as it is; and for each run a `to_tsquery` text that finds it inside sentences
 * (cjkTsQuery).
 */
export function searchQueryParts(query: string): { words: string; cjk: string[] } {
  const cjk: string[] = [];
  const words = query.replace(CJK_RUN, (run) => {
    cjk.push(cjkTsQuery(run));
    return " ";
  });
  return { words: words.trim(), cjk };
}

/**
 * The words of a Chinese or Japanese run worth searching for: the run split at particles (in
 * Japanese, which writes them in hiragana) or Chinese function words. "明日の会議について" → 明日,
 * 会議; "车在哪里" → 车. A word written in hiragana alone stays whole (ありがとう); a run of
 * function words alone gives nothing.
 */
function cjkWords(run: string, japanese: boolean): string[] {
  if (ALL_HIRAGANA.test(run)) return Array.from(run).length > 1 ? [run] : [];
  let text = run;
  if (!japanese) for (const word of FUNCTION_WORDS) text = text.replaceAll(word, " ");
  return Array.from(text)
    .map((char) => (IS_HIRAGANA.test(char) || (!japanese && isFunctionChar(char)) ? " " : char))
    .join("")
    .split(/\s+/)
    .filter(Boolean);
}

/** A Korean word without the particle or ending its last syllable may be (회의를 → 회의). */
function koreanStem(word: string): string {
  const syllables = Array.from(word);
  return syllables.length >= 3 ? syllables.slice(0, -1).join("") : word;
}

const IS_HANGUL = /^\p{Script=Hangul}+$/u;

/**
 * The words of `query` worth searching for: letters and digits only (so nothing else reaches the
 * text-search query), at least 3 characters, no stopwords, each once, long ones cut to their first
 * five letters ("ekstreleri" → "ekstr", matching "ekstresi" too). Chinese and Japanese text gives
 * its words without particles and function words (cjkWords); Korean words count from two
 * syllables, without a last syllable that may be a particle (koreanStem). Case is left to the
 * database, so Turkish İ and I are lowered there the same way as the text. Empty when no word is
 * left.
 */
export function anyWordTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const japanese = hasKana(query);
  const add = (term: string) => {
    const termKey = term.toLocaleLowerCase("tr");
    if (seen.has(termKey) || terms.length === MAX_TERMS) return;
    seen.add(termKey);
    terms.push(term);
  };
  for (const word of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const part of word.split(CJK_PARTS)) {
      if (!part) continue;
      if (IS_CJK.test(part)) {
        for (const cjkWord of cjkWords(part, japanese)) add(cjkWord);
        continue;
      }
      const letters = Array.from(part);
      if (IS_HANGUL.test(part)) {
        const stem = koreanStem(part);
        if (letters.length >= 2 && !STOPWORDS.has(part) && !STOPWORDS.has(stem)) add(stem);
        continue;
      }
      if (letters.length < 3) continue;
      const key = part.toLocaleLowerCase("tr");
      if (STOPWORDS.has(key) || STOPWORDS.has(part.toLowerCase())) continue;
      add(letters.length >= STEM_FROM ? letters.slice(0, STEM).join("") : part);
    }
  }
  return terms;
}

/** Whether a search term is Chinese or Japanese text, found inside words rather than at their start. */
export function isCjkTerm(term: string): boolean {
  return IS_CJK.test(term);
}

/**
 * A `to_tsquery` text matching pages with any of the terms: as prefixes, Chinese and Japanese ones
 * as cjkTsQuery finds them.
 */
export function anyWordTsQuery(terms: string[]): string {
  return terms.map((t) => (isCjkTerm(t) ? cjkTsQuery(t) : `${t}:*`)).join(" | ");
}

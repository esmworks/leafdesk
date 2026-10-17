import { dayNumber, dayString, monthDay, weekdayOf } from "@/lib/time-zone";

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

type Vocabulary = {
  today: string[];
  tomorrow: string[];
  dayAfter: string[];
  nextWeek: string[];
  nextMonth: string[];
  /** Before a weekday: "next friday". */
  nextBefore: string[];
  /** After a weekday: "vendredi prochain". */
  nextAfter: string[];
  /** Before "3 days": "in 3 days". */
  inBefore: string[];
  /** After "3 days": "3 gün sonra". */
  inAfter: string[];
  units: { day: string[]; week: string[]; month: string[] };
  /** Before a date, taken with it: "on friday", "am Freitag". */
  articles: string[];
  /** Forms of the weekdays besides their names (Sunday first): "пятницу" in "в пятницу". */
  weekdays?: string[][];
  /** Endings a word may carry without changing its meaning: "금요일까지" reads as "금요일". */
  endings?: string[];
};

// As people type them; folded (see fold) when a language is first used, so the first ones are
// written folded already. Japanese and Chinese have none: they leave no spaces between words, and
// words here are what is between spaces. In those languages quick add reads English words and
// written dates ("10/15", "10月15日").
const VOCABULARIES: Record<string, Vocabulary> = {
  en: {
    today: ["today"],
    tomorrow: ["tomorrow"],
    dayAfter: ["day after tomorrow"],
    nextWeek: ["next week"],
    nextMonth: ["next month"],
    nextBefore: ["next"],
    nextAfter: [],
    inBefore: ["in"],
    inAfter: [],
    units: { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"] },
    articles: ["on", "by", "due"],
  },
  tr: {
    today: ["bugun"],
    tomorrow: ["yarin"],
    dayAfter: ["obur gun", "oburgun", "yarindan sonra"],
    nextWeek: ["gelecek hafta", "haftaya"],
    nextMonth: ["gelecek ay"],
    nextBefore: ["gelecek", "haftaya"],
    nextAfter: [],
    inBefore: [],
    inAfter: ["sonra"],
    units: { day: ["gun"], week: ["hafta"], month: ["ay"] },
    articles: [],
  },
  de: {
    today: ["heute"],
    tomorrow: ["morgen"],
    dayAfter: ["ubermorgen"],
    nextWeek: ["nachste woche"],
    nextMonth: ["nachsten monat", "nachster monat"],
    nextBefore: ["nachsten", "nachster", "nachste", "kommenden"],
    nextAfter: [],
    inBefore: ["in"],
    inAfter: [],
    units: { day: ["tag", "tagen", "tage"], week: ["woche", "wochen"], month: ["monat", "monaten", "monate"] },
    articles: ["am", "bis"],
  },
  es: {
    today: ["hoy"],
    tomorrow: ["manana"],
    dayAfter: ["pasado manana"],
    nextWeek: ["la proxima semana", "proxima semana", "la semana que viene"],
    nextMonth: ["el proximo mes", "proximo mes", "el mes que viene"],
    nextBefore: ["proximo", "proxima"],
    nextAfter: ["que viene"],
    inBefore: ["en", "dentro de"],
    inAfter: [],
    units: { day: ["dia", "dias"], week: ["semana", "semanas"], month: ["mes", "meses"] },
    articles: ["el"],
  },
  fr: {
    today: ["aujourd'hui"],
    tomorrow: ["demain"],
    dayAfter: ["apres-demain", "apres demain"],
    nextWeek: ["la semaine prochaine", "semaine prochaine"],
    nextMonth: ["le mois prochain", "mois prochain"],
    nextBefore: [],
    nextAfter: ["prochain", "prochaine"],
    inBefore: ["dans"],
    inAfter: [],
    units: { day: ["jour", "jours"], week: ["semaine", "semaines"], month: ["mois"] },
    articles: ["le"],
  },
  it: {
    today: ["oggi"],
    tomorrow: ["domani"],
    dayAfter: ["dopodomani", "dopo domani"],
    nextWeek: ["la prossima settimana", "prossima settimana", "la settimana prossima", "settimana prossima"],
    nextMonth: ["il prossimo mese", "prossimo mese", "il mese prossimo", "mese prossimo"],
    nextBefore: ["prossimo", "prossima"],
    nextAfter: ["prossimo", "prossima"],
    inBefore: ["tra", "fra"],
    inAfter: [],
    units: { day: ["giorno", "giorni"], week: ["settimana", "settimane"], month: ["mese", "mesi"] },
    articles: ["entro il", "entro", "per il", "per", "il"],
  },
  pt: {
    today: ["hoje"],
    tomorrow: ["amanhã"],
    dayAfter: ["depois de amanhã"],
    nextWeek: ["semana que vem", "próxima semana", "a próxima semana"],
    nextMonth: ["mês que vem", "próximo mês", "o próximo mês"],
    nextBefore: ["próximo", "próxima"],
    nextAfter: ["que vem"],
    inBefore: ["em", "daqui a", "dentro de"],
    inAfter: [],
    units: { day: ["dia", "dias"], week: ["semana", "semanas"], month: ["mês", "meses"] },
    articles: ["na", "no", "até", "em"],
    // "sexta" alone is also "sixth", "segunda" "second": only with "feira", hyphen or not.
    weekdays: [[], ["segunda feira"], ["terça feira"], ["quarta feira"], ["quinta feira"], ["sexta feira"], []],
  },
  pl: {
    today: ["dziś", "dzisiaj"],
    tomorrow: ["jutro"],
    dayAfter: ["pojutrze"],
    nextWeek: ["w przyszłym tygodniu", "przyszły tydzień", "w następnym tygodniu"],
    nextMonth: ["w przyszłym miesiącu", "przyszły miesiąc", "w następnym miesiącu"],
    nextBefore: ["przyszły", "przyszłą", "przyszłe", "następny", "następną", "następne"],
    nextAfter: [],
    inBefore: ["za"],
    inAfter: [],
    units: { day: ["dzień", "dni"], week: ["tydzień", "tygodnie", "tygodni"], month: ["miesiąc", "miesiące", "miesięcy"] },
    articles: ["w", "we", "do", "na"],
    // "w środę", "do piątku".
    weekdays: [["niedzielę", "niedzieli"], ["poniedziałku"], ["wtorku"], ["środę", "środy"], ["czwartku"], ["piątku"], ["sobotę", "soboty"]],
  },
  ru: {
    today: ["сегодня"],
    tomorrow: ["завтра"],
    dayAfter: ["послезавтра"],
    nextWeek: ["на следующей неделе", "следующей неделе", "следующая неделя", "на следующую неделю", "следующую неделю"],
    nextMonth: ["в следующем месяце", "следующем месяце", "следующий месяц", "на следующий месяц"],
    nextBefore: ["следующий", "следующую", "следующее", "следующая"],
    nextAfter: [],
    inBefore: ["через"],
    inAfter: [],
    units: { day: ["день", "дня", "дней"], week: ["неделя", "неделю", "недели", "недель"], month: ["месяц", "месяца", "месяцев"] },
    articles: ["в", "во", "на", "до", "к", "ко"],
    // "в пятницу", "до пятницы", "к пятнице". Not "среды", "среде": they are "environment" too.
    weekdays: [
      ["воскресенья", "воскресенью"],
      ["понедельника", "понедельнику"],
      ["вторника", "вторнику"],
      ["среду"],
      ["четверга", "четвергу"],
      ["пятницу", "пятницы", "пятнице"],
      ["субботу", "субботы", "субботе"],
    ],
  },
  uk: {
    today: ["сьогодні"],
    tomorrow: ["завтра"],
    dayAfter: ["післязавтра"],
    nextWeek: ["наступного тижня", "на наступному тижні", "наступний тиждень", "на наступний тиждень"],
    nextMonth: ["наступного місяця", "в наступному місяці", "у наступному місяці", "наступний місяць", "на наступний місяць"],
    nextBefore: ["наступний", "наступну", "наступного", "наступної", "наступне", "наступна"],
    nextAfter: [],
    inBefore: ["через", "за"],
    inAfter: [],
    units: { day: ["день", "дні", "днів"], week: ["тиждень", "тижні", "тижнів"], month: ["місяць", "місяці", "місяців"] },
    articles: ["в", "у", "до", "на"],
    // "у п'ятницю", "до п'ятниці".
    weekdays: [["неділю", "неділі"], ["понеділка"], ["вівторка"], ["середу", "середи"], ["четверга"], ["п'ятницю", "п'ятниці"], ["суботу", "суботи"]],
  },
  ar: {
    today: ["اليوم"],
    tomorrow: ["غدا", "بكرة"],
    dayAfter: ["بعد غد", "بعد غدا"],
    nextWeek: ["الأسبوع القادم", "الأسبوع المقبل"],
    nextMonth: ["الشهر القادم", "الشهر المقبل"],
    nextBefore: [],
    nextAfter: ["القادم", "القادمة", "المقبل", "المقبلة"],
    inBefore: ["بعد", "خلال"],
    inAfter: [],
    units: { day: ["يوم", "أيام"], week: ["أسبوع", "أسابيع"], month: ["شهر", "أشهر", "شهور"] },
    // "يوم الجمعة": the weekday's name comes after "يوم" (day).
    articles: ["يوم", "في", "في يوم", "قبل", "قبل يوم"],
  },
  he: {
    today: ["היום"],
    tomorrow: ["מחר"],
    dayAfter: ["מחרתיים"],
    nextWeek: ["בשבוע הבא", "השבוע הבא", "שבוע הבא"],
    nextMonth: ["בחודש הבא", "החודש הבא", "חודש הבא"],
    nextBefore: [],
    nextAfter: ["הבא", "הבאה", "הקרוב", "הקרובה"],
    inBefore: ["בעוד", "תוך"],
    inAfter: [],
    units: { day: ["יום", "ימים"], week: ["שבוע", "שבועות"], month: ["חודש", "חודשים"] },
    articles: ["עד"],
    // Weekdays are "יום שישי" (day six), "on" is a prefix: "ביום שישי". Saturday is "שבת" too.
    weekdays: [["ביום ראשון"], ["ביום שני"], ["ביום שלישי"], ["ביום רביעי"], ["ביום חמישי"], ["ביום שישי"], ["שבת", "בשבת", "ביום שבת"]],
  },
  fa: {
    today: ["امروز"],
    tomorrow: ["فردا"],
    dayAfter: ["پس\u200cفردا"],
    nextWeek: ["هفته بعد", "هفته آینده", "هفته دیگر"],
    nextMonth: ["ماه بعد", "ماه آینده", "ماه دیگر"],
    nextBefore: [],
    nextAfter: ["بعد", "آینده"],
    inBefore: [],
    inAfter: ["بعد", "دیگر"],
    units: { day: ["روز"], week: ["هفته"], month: ["ماه"] },
    articles: ["تا"],
    // Intl writes these as one word; people also part them: "پنج‌شنبه".
    weekdays: [["یک\u200cشنبه"], ["دو\u200cشنبه"], [], ["چهار\u200cشنبه"], ["پنج\u200cشنبه"], [], []],
    // The ezafe: "هفته‌ی بعد" (the week after).
    endings: ["\u200cی"],
  },
  ko: {
    today: ["오늘"],
    tomorrow: ["내일"],
    dayAfter: ["모레", "내일모레"],
    nextWeek: ["다음 주", "다음주"],
    nextMonth: ["다음 달", "다음달"],
    nextBefore: ["다음 주", "다음주", "다음"],
    nextAfter: [],
    inBefore: [],
    // The unit comes with the number: "3일 후".
    inAfter: ["후", "뒤"],
    units: { day: ["일"], week: ["주", "주일"], month: ["달", "개월"] },
    articles: [],
    // Particles: "금요일까지" (by Friday), "금요일에" (on Friday).
    endings: ["까지", "에는", "에", "엔"],
  },
};

/** English abbreviations of weekdays; other languages' are too often ordinary words ("so", "do"). */
const ENGLISH_WEEKDAY_ABBREVIATIONS: Record<string, number> = {
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
};

/**
 * Lower case without accents, the dotless i as i, Polish ł as l, curly apostrophes straight. In Arabic script
 * without vowel marks and hamza (أ, إ, آ as ا), the Arabic ye and kaf as the Persian ones, and
 * Arabic-Indic digits as 0–9. Hangul syllables and kana come out whole again.
 */
function fold(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/ı/g, "i")
    .replace(/ł/g, "l")
    .replace(/[’`ʼ]/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) & 15))
    .normalize("NFC");
}

/** A folded phrase as people type it: the zero-width non-joiner in Persian words ("سه‌شنبه") is often left out or typed as a space. */
function spellings(phrase: string): string[] {
  return phrase.includes("\u200c") ? [phrase, phrase.replace(/\u200c/g, ""), phrase.replace(/\u200c/g, " ")] : [phrase];
}

const foldPhrases = (phrases: string[]) => phrases.flatMap((phrase) => spellings(fold(phrase)));

function foldVocabulary({ units, weekdays, endings, ...phrases }: Vocabulary): Vocabulary {
  return {
    ...(Object.fromEntries(Object.entries(phrases).map(([key, list]) => [key, foldPhrases(list)])) as Omit<Vocabulary, "units" | "weekdays" | "endings">),
    units: { day: foldPhrases(units.day), week: foldPhrases(units.week), month: foldPhrases(units.month) },
    weekdays: weekdays?.map(foldPhrases),
    // Longest first: "에는" before "에".
    endings: endings?.map(fold).sort((a, b) => b.length - a.length),
  };
}

/** Languages that write a slash date month first: "10/15". */
const MONTH_FIRST = new Set(["en", "ja", "ko", "zh"]);

type Language = { vocabulary: Vocabulary; weekdays: Map<string, number>; months: Map<string, number>; monthFirst: boolean };

const languages = new Map<string, Language>();

function language(code: string): Language {
  let found = languages.get(code);
  if (found) return found;
  const vocabulary = foldVocabulary(VOCABULARIES[code] ?? VOCABULARIES.en);
  // Names may be more than one word ("יום שישי").
  const weekdays = new Map<string, number>();
  // 2024-01-07 was a Sunday: weekday index 0.
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(2024, 0, 7 + i));
    const name = new Intl.DateTimeFormat(code, { weekday: "long", timeZone: "UTC" }).format(date);
    for (const form of [...spellings(fold(name)), ...(vocabulary.weekdays?.[i] ?? [])]) weekdays.set(form, i);
  }
  if (code === "en") for (const [name, day] of Object.entries(ENGLISH_WEEKDAY_ABBREVIATIONS)) weekdays.set(name, day);
  const months = new Map<string, number>();
  for (let m = 0; m < 12; m++) {
    const date = new Date(Date.UTC(2024, m, 15));
    for (const month of ["long", "short"] as const) {
      // Gregorian months in every language (Persian's own calendar is the default there). With a
      // day, Slavic languages decline the name: "15 октября", "15 października".
      const options = { month, timeZone: "UTC", calendar: "gregory" } as const;
      const alone = new Intl.DateTimeFormat(code, options).format(date);
      const withDay = new Intl.DateTimeFormat(code, { ...options, day: "numeric" }).formatToParts(date).find((part) => part.type === "month");
      for (const form of [alone, withDay?.value ?? alone]) {
        // "Okt.", "sept." come with a dot; Turkish "Eki" is fine as it is.
        const name = fold(form).replace(/\.$/, "");
        if (name.length >= 3 && !/\d/.test(name)) months.set(name, m + 1);
      }
    }
  }
  if (code === "en") months.set("sept", 9);
  found = { vocabulary, weekdays, months, monthFirst: MONTH_FIRST.has(code) };
  languages.set(code, found);
  return found;
}

type Token = { word: string; start: number; end: number };

/** Words with their place in the text; trailing commas and the like are not part of the word. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0].replace(/[,;!?)]+$/, "");
    if (!raw) continue;
    tokens.push({ word: fold(raw), start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

/** Without a trailing dot ("Friday." at the end of a sentence, "15." in "15. Oktober"). */
const bare = (word: string) => word.replace(/\.$/, "");

/** The tokens as `lang` reads them, without the endings its words may carry ("금요일까지" as "금요일"). */
function readAs(tokens: Token[], lang: Language): Token[] {
  const endings = lang.vocabulary.endings;
  if (!endings?.length) return tokens;
  return tokens.map((token) => {
    const word = bare(token.word);
    const ending = endings.find((e) => word.length > e.length && word.endsWith(e));
    return ending ? { ...token, word: word.slice(0, -ending.length) } : token;
  });
}

/** How many tokens from `i` one of `phrases` takes (the longest), or 0. */
function phraseAt(tokens: Token[], i: number, phrases: string[]): number {
  let best = 0;
  for (const phrase of phrases) {
    const words = phrase.split(" ");
    if (words.length <= best || i + words.length > tokens.length) continue;
    if (words.every((word, k) => bare(tokens[i + k].word) === word)) best = words.length;
  }
  return best;
}

/** The weekday at `i` (0 is Sunday) and how many tokens its name takes, the longest name winning. */
function weekdayAt(tokens: Token[], i: number, lang: Language): { weekday: number; length: number } | null {
  let found: { weekday: number; length: number } | null = null;
  for (const [name, weekday] of lang.weekdays) {
    const length = phraseAt(tokens, i, [name]);
    if (length > (found?.length ?? 0)) found = { weekday, length };
  }
  return found;
}

function addMonths(day: number, months: number): number {
  const [y, m, d] = dayString(day).split("-").map(Number);
  return monthDay(y * 12 + m - 1 + months, d);
}

/** A valid day number for the date, or null ("31.02." is no date). */
function calendarDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return date.getTime() / 86_400_000;
}

/** A date without a year that already passed this year is next year's. */
function upcoming(today: number, month: number, day: number): number | null {
  const year = Number(dayString(today).slice(0, 4));
  const thisYear = calendarDay(year, month, day);
  if (thisYear === null) return calendarDay(year + 1, month, day);
  return thisYear < today ? calendarDay(year + 1, month, day) : thisYear;
}

function fullYear(text: string): number {
  const year = Number(text);
  return text.length === 2 ? 2000 + year : year;
}

const DAY_NUMBER = /^(\d{1,2})\.?$/;
const YEAR = /^(\d{4})$/;

type Found = { length: number; day: number };

function dateAt(tokens: Token[], i: number, lang: Language, today: number): Found | null {
  const v = lang.vocabulary;
  const word = (k: number) => (i + k < tokens.length ? bare(tokens[i + k].word) : "");

  let n = phraseAt(tokens, i, v.dayAfter);
  if (n) return { length: n, day: today + 2 };
  n = phraseAt(tokens, i, v.today);
  if (n) return { length: n, day: today };
  n = phraseAt(tokens, i, v.tomorrow);
  if (n) return { length: n, day: today + 1 };
  // "next friday": that day next week (weeks start on Monday); "friday": the next friday after today.
  const next = phraseAt(tokens, i, v.nextBefore);
  const named = weekdayAt(tokens, i + next, lang);
  if (named) {
    const { weekday } = named;
    const after = next ? 0 : phraseAt(tokens, i + named.length, v.nextAfter);
    let day = today + ((weekday - weekdayOf(today) + 7) % 7 || 7);
    if (next || after) {
      const mondayNextWeek = today + 7 - ((weekdayOf(today) + 6) % 7);
      day = mondayNextWeek + ((weekday + 6) % 7);
    }
    return { length: next + named.length + after, day };
  }

  n = phraseAt(tokens, i, v.nextWeek);
  if (n) return { length: n, day: today + 7 - ((weekdayOf(today) + 6) % 7) };
  n = phraseAt(tokens, i, v.nextMonth);
  if (n) {
    // The first of next month (`m` counts from 1, so it is next month's index).
    const [y, m] = dayString(today).split("-").map(Number);
    return { length: n, day: monthDay(y * 12 + m, 1) };
  }

  // "in 3 days", "3 gün sonra", "dans 2 semaines"; the unit may come with the number ("3일 후").
  const counted = (k: number): Found | null => {
    const number = /^(\d{1,3})(\D*)$/.exec(word(k));
    const count = Number(number?.[1]);
    if (!number || !count) return null;
    const unit = number[2] || word(k + 1);
    const length = number[2] ? k + 1 : k + 2;
    if (v.units.day.includes(unit)) return { length, day: today + count };
    if (v.units.week.includes(unit)) return { length, day: today + 7 * count };
    if (v.units.month.includes(unit)) return { length, day: addMonths(today, count) };
    return null;
  };
  const before = phraseAt(tokens, i, v.inBefore);
  if (before) {
    const found = counted(before);
    if (found) return found;
  } else if (v.inAfter.length) {
    const found = counted(0);
    const after = found ? phraseAt(tokens, i + found.length, v.inAfter) : 0;
    if (found && after) return { ...found, length: found.length + after };
  }

  const token = tokens[i].word;
  // 2026-10-15
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (m) {
    const day = calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
    return day === null ? null : { length: 1, day };
  }
  // 10/15 and 10/15/2026 in English; 15/10, 15.10.2026 and "15.10." elsewhere. A bare "3.5" is
  // more likely a version than a date.
  m = /^(\d{1,2})([/.])(\d{1,2})(?:\2(\d{2}|\d{4})?)?$/.exec(token);
  const trailingDot = m?.[2] === "." && token.endsWith(".");
  if (m && (m[2] === "/" || m[4] || trailingDot)) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    const [month, date] = lang.monthFirst && m[2] === "/" ? [a, b] : [b, a];
    const day = m[4] ? calendarDay(fullYear(m[4]), month, date) : upcoming(today, month, date);
    return day === null ? null : { length: 1, day };
  }

  // "10月15日" in Japanese and Chinese, "10월 15일" in Korean.
  m = /^(\d{1,2})[月월](?:(\d{1,2})[日일]?)?$/.exec(token);
  if (m) {
    const date = m[2] ?? /^(\d{1,2})[日일]$/.exec(word(1))?.[1];
    const day = date ? upcoming(today, Number(m[1]), Number(date)) : null;
    if (day !== null) return { length: m[2] ? 1 : 2, day };
  }

  // "15 Oct", "15. Oktober 2026", "15 de octubre"; "Oct 15, 2026" in English.
  const dayFirst = DAY_NUMBER.exec(token);
  if (dayFirst) {
    const of = word(1) === "de" ? 1 : 0;
    const month = lang.months.get(word(1 + of));
    if (month) {
      const year = YEAR.exec(word(2 + of));
      const date = Number(dayFirst[1]);
      const day = year ? calendarDay(Number(year[1]), month, date) : upcoming(today, month, date);
      return day === null ? null : { length: 2 + of + (year ? 1 : 0), day };
    }
  }
  const month = lang.months.get(bare(token));
  if (month && lang.monthFirst) {
    const date = /^(\d{1,2})(?:st|nd|rd|th)?,?$/.exec(tokens[i + 1]?.word ?? "");
    if (date) {
      const year = YEAR.exec(word(2));
      const day = year ? calendarDay(Number(year[1]), month, Number(date[1])) : upcoming(today, month, Number(date[1]));
      return day === null ? null : { length: 2 + (year ? 1 : 0), day };
    }
  }
  return null;
}

/** A date at `i`, with an article before it taken along ("on friday"). */
function dateFrom(tokens: Token[], i: number, lang: Language, today: number): Found | null {
  const article = phraseAt(tokens, i, lang.vocabulary.articles);
  if (article && i + article < tokens.length) {
    const found = dateAt(tokens, i + article, lang, today);
    if (found) return { ...found, length: found.length + article };
  }
  return dateAt(tokens, i, lang, today);
}

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
  const code = context.locale.split("-")[0];
  const langs = [language(code), ...(code === "en" ? [] : [language("en")])];
  const tokens = tokenize(text);
  const readings = langs.map((lang) => ({ lang, tokens: readAs(tokens, lang) }));
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
  title = title.replace(/\s+/g, " ").replace(/\s+([,;.!?])/g, "$1").replace(/^[\s,;]+|[\s,;]+$/g, "");

  return {
    title,
    date: date === null ? null : dayString(date),
    people,
    options,
    matches,
  };
}

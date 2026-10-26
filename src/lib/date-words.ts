import { dayString, monthDay, weekdayOf } from "@/lib/time-zone";

/**
 * Dates written in words, as people type them in their interface language and in English: "next
 * friday", "in 3 days", "3 gün sonra", "15. Oktober", "10/15". Quick add (lib/quick-add) finds them
 * inside a row's title; date phrases (lib/date-phrase) read a whole phrase as a date, with the
 * stricter rules of a box that holds nothing else. Pure and client-safe; no date library.
 */

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
  /** The day before today. Like the "ago" words, only for dates on their own (parseDateText). */
  yesterday: string[];
  /** Before "3 days": "vor 3 Tagen". */
  agoBefore: string[];
  /** After "3 days": "3 days ago". */
  agoAfter: string[];
  /** Both words are needed: "for 3 dage siden" (Danish "for" alone is "for"). */
  agoAround?: boolean;
  units: { day: string[]; week: string[]; month: string[] };
  /** Before a date, taken with it: "on friday", "am Freitag". */
  articles: string[];
  /** Forms of the weekdays besides their names (Sunday first): "пятницу" in "в пятницу". */
  weekdays?: string[][];
  /** Endings a word may carry without changing its meaning: "금요일까지" reads as "금요일". */
  endings?: string[];
  /** After a date, taken with it: "までに" in "金曜日までに" (by Friday). */
  particles?: string[];
  /** Before a time of day in a date phrase (lib/date-phrase): "um 17:30", "saat 17:30". English "at" always works. */
  at?: string[];
};

// As people type them; folded (see fold) when a language is first used, so the first ones are
// written folded already. Japanese and Chinese leave no spaces between words: their text is read
// a character at a time (see GLUED), and their phrases are matched the same way.
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
    yesterday: ["yesterday"],
    agoBefore: [],
    agoAfter: ["ago"],
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
    yesterday: ["dün"],
    agoBefore: [],
    agoAfter: ["önce"],
    units: { day: ["gun"], week: ["hafta"], month: ["ay"] },
    articles: [],
    at: ["saat"],
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
    yesterday: ["gestern"],
    agoBefore: ["vor"],
    agoAfter: [],
    units: { day: ["tag", "tagen", "tage"], week: ["woche", "wochen"], month: ["monat", "monaten", "monate"] },
    articles: ["am", "bis"],
    at: ["um"],
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
    yesterday: ["ayer"],
    agoBefore: ["hace"],
    agoAfter: [],
    units: { day: ["dia", "dias"], week: ["semana", "semanas"], month: ["mes", "meses"] },
    articles: ["el"],
    at: ["a las", "a la"],
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
    yesterday: ["hier"],
    agoBefore: ["il y a"],
    agoAfter: [],
    units: { day: ["jour", "jours"], week: ["semaine", "semaines"], month: ["mois"] },
    articles: ["le"],
    at: ["à"],
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
    yesterday: ["ieri"],
    agoBefore: [],
    agoAfter: ["fa"],
    units: { day: ["giorno", "giorni"], week: ["settimana", "settimane"], month: ["mese", "mesi"] },
    articles: ["entro il", "entro", "per il", "per", "il"],
    at: ["alle", "alle ore"],
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
    yesterday: ["ontem"],
    agoBefore: ["há"],
    agoAfter: ["atrás"],
    units: { day: ["dia", "dias"], week: ["semana", "semanas"], month: ["mês", "meses"] },
    articles: ["na", "no", "até", "em"],
    at: ["às"],
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
    yesterday: ["wczoraj"],
    agoBefore: [],
    agoAfter: ["temu"],
    units: { day: ["dzień", "dni"], week: ["tydzień", "tygodnie", "tygodni"], month: ["miesiąc", "miesiące", "miesięcy"] },
    articles: ["w", "we", "do", "na"],
    at: ["o", "o godzinie"],
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
    yesterday: ["вчера"],
    agoBefore: [],
    agoAfter: ["назад"],
    units: { day: ["день", "дня", "дней"], week: ["неделя", "неделю", "недели", "недель"], month: ["месяц", "месяца", "месяцев"] },
    articles: ["в", "во", "на", "до", "к", "ко"],
    at: ["в"],
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
    yesterday: ["вчора"],
    agoBefore: [],
    agoAfter: ["тому"],
    units: { day: ["день", "дні", "днів"], week: ["тиждень", "тижні", "тижнів"], month: ["місяць", "місяці", "місяців"] },
    articles: ["в", "у", "до", "на"],
    at: ["о", "об"],
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
    yesterday: ["أمس", "البارحة"],
    agoBefore: ["قبل", "منذ"],
    agoAfter: [],
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
    yesterday: ["אתמול"],
    agoBefore: ["לפני"],
    agoAfter: [],
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
    yesterday: ["دیروز"],
    agoBefore: [],
    agoAfter: ["پیش", "قبل"],
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
    yesterday: ["어제"],
    agoBefore: [],
    agoAfter: ["전"],
    units: { day: ["일"], week: ["주", "주일"], month: ["달", "개월"] },
    articles: [],
    // Particles: "금요일까지" (by Friday), "금요일에" (on Friday).
    endings: ["까지", "에는", "에", "엔"],
  },
  ja: {
    today: ["今日", "きょう", "本日"],
    tomorrow: ["明日", "あした", "あす"],
    dayAfter: ["明後日", "あさって"],
    nextWeek: ["来週"],
    nextMonth: ["来月"],
    nextBefore: ["来週の", "来週"],
    nextAfter: [],
    inBefore: [],
    // "3日後" (in 3 days).
    inAfter: ["後"],
    yesterday: ["昨日"],
    agoBefore: [],
    agoAfter: ["前"],
    units: { day: ["日", "日間"], week: ["週間", "週"], month: ["か月", "ヶ月", "カ月", "ヵ月"] },
    // "今週金曜日": this week's Friday, the next one.
    articles: ["今週の", "今週"],
    weekdays: [["日曜"], ["月曜"], ["火曜"], ["水曜"], ["木曜"], ["金曜"], ["土曜"]],
    particles: ["までに", "まで", "には", "に"],
  },
  zh: {
    today: ["今天", "今日"],
    tomorrow: ["明天", "明日"],
    dayAfter: ["后天"],
    nextWeek: ["下周", "下星期", "下礼拜", "下个星期"],
    nextMonth: ["下个月", "下月"],
    // "下周五", "下个星期五" (next Friday).
    nextBefore: ["下个", "下"],
    nextAfter: [],
    inBefore: [],
    inAfter: ["以后", "之后", "后"],
    yesterday: ["昨天"],
    agoBefore: [],
    agoAfter: ["前", "以前", "之前"],
    units: { day: ["天"], week: ["个星期", "星期", "周"], month: ["个月"] },
    articles: ["这个", "这", "本"],
    weekdays: [
      ["周日", "周天", "星期天", "礼拜天", "礼拜日"],
      ["周一", "礼拜一"],
      ["周二", "礼拜二"],
      ["周三", "礼拜三"],
      ["周四", "礼拜四"],
      ["周五", "礼拜五"],
      ["周六", "礼拜六"],
    ],
    // "周五前" (before Friday).
    particles: ["之前", "以前", "前"],
  },
  id: {
    today: ["hari ini"],
    tomorrow: ["besok"],
    dayAfter: ["lusa"],
    nextWeek: ["minggu depan", "pekan depan"],
    nextMonth: ["bulan depan"],
    nextBefore: [],
    // "Jumat depan" (next Friday).
    nextAfter: ["depan"],
    inBefore: ["dalam"],
    // "3 hari lagi" (in 3 days).
    inAfter: ["lagi"],
    yesterday: ["kemarin"],
    agoBefore: [],
    agoAfter: ["lalu", "yang lalu"],
    units: { day: ["hari"], week: ["minggu", "pekan"], month: ["bulan"] },
    articles: ["pada", "hari", "pada hari", "sebelum"],
    at: ["pukul", "jam"],
    weekdays: [[], [], [], [], [], ["jum'at"], []],
  },
  // Thai leaves no spaces between words; dates are found where they are written apart from the
  // rest ("ประชุม พรุ่งนี้").
  th: {
    today: ["วันนี้"],
    tomorrow: ["พรุ่งนี้"],
    dayAfter: ["มะรืนนี้", "มะรืน"],
    nextWeek: ["สัปดาห์หน้า", "อาทิตย์หน้า"],
    nextMonth: ["เดือนหน้า"],
    nextBefore: [],
    nextAfter: ["หน้า"],
    // "อีก 3 วัน" (in 3 days).
    inBefore: ["อีก", "ใน"],
    inAfter: [],
    yesterday: ["เมื่อวาน", "เมื่อวานนี้"],
    agoBefore: [],
    agoAfter: ["ที่แล้ว", "ก่อน"],
    units: { day: ["วัน"], week: ["สัปดาห์"], month: ["เดือน"] },
    articles: ["ภายใน", "ก่อน"],
    weekdays: [["อาทิตย์"], ["จันทร์"], ["อังคาร"], ["พุธ"], ["พฤหัส", "พฤหัสบดี"], ["ศุกร์"], ["เสาร์"]],
  },
  vi: {
    today: ["hôm nay"],
    tomorrow: ["ngày mai"],
    dayAfter: ["ngày kia", "ngày mốt"],
    nextWeek: ["tuần sau", "tuần tới"],
    nextMonth: ["tháng sau", "tháng tới"],
    nextBefore: [],
    // "thứ Sáu tuần sau", "thứ Sáu tới" (next Friday).
    nextAfter: ["tuần sau", "tuần tới", "tới"],
    inBefore: ["trong", "sau"],
    // "3 ngày nữa" (in 3 days).
    inAfter: ["nữa"],
    yesterday: ["hôm qua"],
    agoBefore: [],
    agoAfter: ["trước"],
    units: { day: ["ngày"], week: ["tuần"], month: ["tháng"] },
    articles: ["vào", "trước", "hạn"],
    at: ["lúc"],
  },
  // Danish and Norwegian æ and ø stay as they are; å folds to a.
  da: {
    today: ["i dag"],
    tomorrow: ["i morgen"],
    dayAfter: ["i overmorgen", "overmorgen"],
    nextWeek: ["næste uge"],
    nextMonth: ["næste maned"],
    nextBefore: ["næste", "kommende"],
    nextAfter: [],
    inBefore: ["om"],
    inAfter: [],
    yesterday: ["i går"],
    agoBefore: ["for"],
    agoAfter: ["siden"],
    agoAround: true,
    units: { day: ["dag", "dage"], week: ["uge", "uger"], month: ["maned", "maneder"] },
    articles: ["pa", "inden", "senest"],
    at: ["kl", "klokken"],
  },
  nb: {
    today: ["i dag"],
    tomorrow: ["i morgen"],
    dayAfter: ["i overmorgen", "overmorgen"],
    nextWeek: ["neste uke"],
    nextMonth: ["neste maned"],
    nextBefore: ["neste", "kommende"],
    nextAfter: [],
    inBefore: ["om"],
    inAfter: [],
    yesterday: ["i går"],
    agoBefore: ["for"],
    agoAfter: ["siden"],
    agoAround: true,
    units: { day: ["dag", "dager"], week: ["uke", "uker"], month: ["maned", "maneder"] },
    articles: ["pa", "innen", "senest"],
    at: ["kl", "klokken"],
  },
  sv: {
    today: ["idag", "i dag"],
    tomorrow: ["imorgon", "i morgon"],
    dayAfter: ["i overmorgon", "overmorgon"],
    nextWeek: ["nasta vecka"],
    nextMonth: ["nasta manad"],
    nextBefore: ["nasta", "kommande"],
    nextAfter: [],
    inBefore: ["om"],
    inAfter: [],
    yesterday: ["igår", "i går"],
    agoBefore: ["för"],
    agoAfter: ["sedan"],
    agoAround: true,
    units: { day: ["dag", "dagar"], week: ["vecka", "veckor"], month: ["manad", "manader"] },
    articles: ["pa", "senast"],
    at: ["kl", "klockan"],
  },
  nl: {
    today: ["vandaag"],
    tomorrow: ["morgen"],
    dayAfter: ["overmorgen"],
    nextWeek: ["volgende week"],
    nextMonth: ["volgende maand"],
    nextBefore: ["volgende", "komende"],
    nextAfter: [],
    inBefore: ["over", "binnen"],
    inAfter: [],
    yesterday: ["gisteren"],
    agoBefore: [],
    agoAfter: ["geleden"],
    units: { day: ["dag", "dagen"], week: ["week", "weken"], month: ["maand", "maanden"] },
    articles: ["op", "voor", "uiterlijk"],
    at: ["om"],
  },
  fi: {
    today: ["tanaan"],
    tomorrow: ["huomenna"],
    dayAfter: ["ylihuomenna"],
    nextWeek: ["ensi viikolla", "ensi viikko"],
    nextMonth: ["ensi kuussa", "ensi kuu"],
    nextBefore: ["ensi"],
    nextAfter: [],
    inBefore: [],
    // "3 päivän päästä", "2 viikon kuluttua" (in 3 days, in 2 weeks): the unit in the genitive.
    inAfter: ["paasta", "kuluttua"],
    yesterday: ["eilen"],
    agoBefore: [],
    agoAfter: ["sitten"],
    units: { day: ["paiva", "paivaa", "paivan"], week: ["viikko", "viikkoa", "viikon"], month: ["kuukausi", "kuukautta", "kuukauden"] },
    articles: [],
    at: ["klo", "kello"],
    // "perjantaina" (on Friday) besides "perjantai".
    weekdays: [["sunnuntaina"], ["maanantaina"], ["tiistaina"], ["keskiviikkona"], ["torstaina"], ["perjantaina"], ["lauantaina"]],
  },
};

/**
 * Languages written without spaces between words. Their text is read a character at a time
 * (tokenize), and their phrases are written the same way, a space between characters ("来 週"),
 * so a phrase of several characters is matched as one of several words elsewhere.
 */
const GLUED = new Set(["ja", "zh"]);
const spaced = (phrase: string) => Array.from(phrase).join(" ");

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
/** In a phrase on its own (lib/date-phrase), where they can mean nothing else. */
const ENGLISH_PHRASE_WEEKDAYS: Record<string, number> = { sat: 6, sun: 0 };

/**
 * Lower case without accents, the dotless i as i, Polish ł as l, curly apostrophes straight. In Arabic script
 * without vowel marks and hamza (أ, إ, آ as ا), the Arabic ye and kaf as the Persian ones, and
 * Arabic-Indic digits as 0–9. Hangul syllables and kana come out whole again.
 */
export function fold(text: string): string {
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

function foldVocabulary({ units, weekdays, endings, agoAround, ...phrases }: Vocabulary): Vocabulary {
  return {
    ...(Object.fromEntries(Object.entries(phrases).map(([key, list]) => [key, foldPhrases(list)])) as Omit<Vocabulary, "units" | "weekdays" | "endings" | "agoAround">),
    agoAround,
    units: { day: foldPhrases(units.day), week: foldPhrases(units.week), month: foldPhrases(units.month) },
    weekdays: weekdays?.map(foldPhrases),
    // Longest first: "에는" before "에".
    endings: endings?.map(fold).sort((a, b) => b.length - a.length),
  };
}

/** A vocabulary of a GLUED language with its phrases written a character at a time. */
function spaceVocabulary({ units, weekdays, endings, agoAround, ...phrases }: Vocabulary): Vocabulary {
  return {
    ...(Object.fromEntries(Object.entries(phrases).map(([key, list]) => [key, list.map(spaced)])) as Omit<Vocabulary, "units" | "weekdays" | "endings" | "agoAround">),
    agoAround,
    units: { day: units.day.map(spaced), week: units.week.map(spaced), month: units.month.map(spaced) },
    weekdays: weekdays?.map((forms) => forms.map(spaced)),
    endings,
  };
}

/** Languages that write a slash date month first: "10/15". */
const MONTH_FIRST = new Set(["en", "ja", "ko", "zh"]);

export type Language = {
  vocabulary: Vocabulary;
  weekdays: Map<string, number>;
  /** Names of months (long, short and declined forms, folded) and their numbers (1–12). */
  months: Map<string, number>;
  monthFirst: boolean;
};

const languages = new Map<string, Language>();

export function language(code: string): Language {
  let found = languages.get(code);
  if (found) return found;
  const glued = GLUED.has(code);
  const folded = foldVocabulary(VOCABULARIES[code] ?? VOCABULARIES.en);
  const vocabulary = glued ? spaceVocabulary(folded) : folded;
  // Names may be more than one word ("יום שישי").
  const weekdays = new Map<string, number>();
  // 2024-01-07 was a Sunday: weekday index 0.
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(2024, 0, 7 + i));
    const name = new Intl.DateTimeFormat(code, { weekday: "long", timeZone: "UTC" }).format(date);
    const names = spellings(fold(name)).map((form) => (glued ? spaced(form) : form));
    for (const form of [...names, ...(vocabulary.weekdays?.[i] ?? [])]) weekdays.set(form, i);
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

/** The languages a text in `locale` is read in: the interface language, then English. */
export function languagesFor(locale: string): Language[] {
  const code = locale.split("-")[0];
  return [language(code), ...(code === "en" ? [] : [language("en")])];
}

export const isGlued = (locale: string) => GLUED.has(locale.split("-")[0]);

/** The words that may come before a time of day in `locale` ("at", "um"), folded. */
export function timeWords(locale: string): string[] {
  return ["at", ...languagesFor(locale).flatMap((lang) => lang.vocabulary.at ?? [])];
}

export type Token = { word: string; start: number; end: number };

/**
 * In a GLUED language, the parts of a word: each Chinese character and kana alone, other text
 * ("10/15", "3", "tomorrow") as it is, and a written date ("10月15日") whole.
 */
const GLUED_PART = /\d{1,2}月(?:\d{1,2}日?)?|[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々]|[^\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々]+/gu;

/** Words with their place in the text; trailing commas and the like are not part of the word. */
export function tokenize(text: string, glued: boolean): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0].replace(/[,;!?)、，。！？]+$/, "");
    if (!raw) continue;
    if (!glued) {
      tokens.push({ word: fold(raw), start: match.index, end: match.index + raw.length });
      continue;
    }
    for (const part of raw.matchAll(GLUED_PART)) {
      const start = match.index + part.index;
      tokens.push({ word: fold(part[0]), start, end: start + part[0].length });
    }
  }
  return tokens;
}

/** Without a trailing dot ("Friday." at the end of a sentence, "15." in "15. Oktober"). */
const bare = (word: string) => word.replace(/\.$/, "");

/** The tokens as `lang` reads them, without the endings its words may carry ("금요일까지" as "금요일"). */
export function readAs(tokens: Token[], lang: Language): Token[] {
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

/** How dates are read. */
export type ReadRules = {
  /** Dates in the past too: "yesterday", "3 days ago". */
  past?: boolean;
  /** The day weeks start on (0 is Sunday) for "next friday" and "next week"; Monday when missing. */
  weekStart?: number;
  /**
   * A whole phrase on its own (lib/date-phrase), where words can mean nothing but a date: "sat" and
   * "sun" are weekdays, any three or more first letters name a month ("septem"), "aug 31" is month
   * first in every language, and slash dates follow `order`.
   */
  phrase?: boolean;
  /**
   * Phrases only: which number of a slash date ("10/11") is the month when both could be; the
   * language's own order when missing. "ymd" reads a pair only when one number can't be a month.
   */
  order?: "mdy" | "dmy" | "ymd";
};

/** The weekday at `i` (0 is Sunday) and how many tokens its name takes, the longest name winning. */
function weekdayAt(tokens: Token[], i: number, lang: Language, phrase: boolean): { weekday: number; length: number } | null {
  let found: { weekday: number; length: number } | null = null;
  for (const [name, weekday] of lang.weekdays) {
    const length = phraseAt(tokens, i, [name]);
    if (length > (found?.length ?? 0)) found = { weekday, length };
  }
  const short = phrase && lang === language("en") && i < tokens.length ? ENGLISH_PHRASE_WEEKDAYS[bare(tokens[i].word)] : undefined;
  return found ?? (short === undefined ? null : { weekday: short, length: 1 });
}

/** The month `word` names (1–12): a name, or in a phrase any first three letters or more of exactly one month's. */
function monthOf(word: string, lang: Language, phrase: boolean): number | undefined {
  const month = lang.months.get(word);
  if (month || !phrase || word.length < 3 || !/^\p{L}+$/u.test(word)) return month;
  const months = new Set<number>();
  for (const [name, m] of lang.months) if (name.startsWith(word)) months.add(m);
  return months.size === 1 ? [...months][0] : undefined;
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

/**
 * Month and day of a slash or dot date in a phrase: in `monthFirst` order when both numbers could
 * be the month, else whichever one can be; null when neither can, or both can and no order is
 * given (a year-first order reading "10/11").
 */
function phraseMonthDay(a: number, b: number, monthFirst: boolean | null): [number, number] | null {
  const aMonth = a >= 1 && a <= 12;
  const bMonth = b >= 1 && b <= 12;
  if (aMonth && bMonth) return monthFirst === null ? null : monthFirst ? [a, b] : [b, a];
  if (aMonth) return [a, b];
  if (bMonth) return [b, a];
  return null;
}

const DAY_NUMBER = /^(\d{1,2})\.?$/;
const YEAR = /^(\d{4})$/;

export type Found = { length: number; day: number };

function dateAt(tokens: Token[], i: number, lang: Language, today: number, rules: ReadRules): Found | null {
  const v = lang.vocabulary;
  const phrase = rules.phrase === true;
  const weekStart = rules.weekStart ?? 1;
  const word = (k: number) => (i + k < tokens.length ? bare(tokens[i + k].word) : "");
  // The first day of next week.
  const nextWeek = () => today + 7 - ((weekdayOf(today) - weekStart + 7) % 7);

  if (rules.past) {
    const n = phraseAt(tokens, i, v.yesterday);
    if (n) return { length: n, day: today - 1 };
  }

  let n = phraseAt(tokens, i, v.dayAfter);
  if (n) return { length: n, day: today + 2 };
  n = phraseAt(tokens, i, v.today);
  if (n) return { length: n, day: today };
  n = phraseAt(tokens, i, v.tomorrow);
  if (n) return { length: n, day: today + 1 };
  // "next friday": that day next week; "friday": the next friday after today.
  const next = phraseAt(tokens, i, v.nextBefore);
  const named = weekdayAt(tokens, i + next, lang, phrase);
  if (named) {
    const { weekday } = named;
    const after = next ? 0 : phraseAt(tokens, i + named.length, v.nextAfter);
    let day = today + ((weekday - weekdayOf(today) + 7) % 7 || 7);
    if (next || after) day = nextWeek() + ((weekday - weekStart + 7) % 7);
    return { length: next + named.length + after, day };
  }

  n = phraseAt(tokens, i, v.nextWeek);
  if (n) return { length: n, day: nextWeek() };
  n = phraseAt(tokens, i, v.nextMonth);
  if (n) {
    // The first of next month (`m` counts from 1, so it is next month's index).
    const [y, m] = dayString(today).split("-").map(Number);
    return { length: n, day: monthDay(y * 12 + m, 1) };
  }

  // "in 3 days", "3 gün sonra", "dans 2 semaines"; the unit may come with the number ("3일 후").
  const counted = (k: number, sign = 1): Found | null => {
    const number = /^(\d{1,3})(\D*)$/.exec(word(k));
    const count = Number(number?.[1]);
    if (!number || !count) return null;
    // The words the unit takes after the number: none when it comes with it, more than one when
    // it is ("週 間"); -1 when there is no such unit.
    const unit = (units: string[]) => (number[2] ? (units.includes(number[2]) ? 0 : -1) : phraseAt(tokens, i + k + 1, units) || -1);
    const days = unit(v.units.day);
    if (days >= 0) return { length: k + 1 + days, day: today + sign * count };
    const weeks = unit(v.units.week);
    if (weeks >= 0) return { length: k + 1 + weeks, day: today + sign * 7 * count };
    const months = unit(v.units.month);
    if (months >= 0) return { length: k + 1 + months, day: addMonths(today, sign * count) };
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
  // "3 days ago", "vor 3 Tagen", "for 3 dage siden".
  if (rules.past) {
    const ago = phraseAt(tokens, i, v.agoBefore);
    const found = counted(ago, -1);
    const after = found ? phraseAt(tokens, i + found.length, v.agoAfter) : 0;
    if (found && (v.agoAround ? ago && after : ago || after)) return { ...found, length: found.length + after };
  }

  const token = tokens[i].word;
  // 2026-10-15; in a phrase 2026/10/15 too.
  let m = (phrase ? /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/ : /^(\d{4})(-)(\d{2})-(\d{2})$/).exec(token);
  if (m) {
    const day = calendarDay(Number(m[1]), Number(m[3]), Number(m[4]));
    return day === null ? null : { length: 1, day };
  }
  // 10/15 and 10/15/2026 in English; 15/10, 15.10.2026 and "15.10." elsewhere. A bare "3.5" is
  // more likely a version than a date.
  m = /^(\d{1,2})([/.])(\d{1,2})(?:\2(\d{2}|\d{4})?)?$/.exec(token);
  const trailingDot = m?.[2] === "." && token.endsWith(".");
  if (m && (m[2] === "/" || m[4] || trailingDot)) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    if (phrase) {
      // "10/28/27": 27 could be the day as well as the year.
      if (m[4]?.length === 2) return null;
      const order = m[2] === "." ? "dmy" : (rules.order ?? (lang.monthFirst ? "mdy" : "dmy"));
      const parts = phraseMonthDay(a, b, order === "ymd" ? null : order === "mdy");
      if (!parts) return null;
      const day = m[4] ? calendarDay(Number(m[4]), parts[0], parts[1]) : upcoming(today, parts[0], parts[1]);
      return day === null ? null : { length: 1, day };
    }
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
    const month = monthOf(word(1 + of), lang, phrase);
    if (month) {
      const year = YEAR.exec(word(2 + of));
      const date = Number(dayFirst[1]);
      const day = year ? calendarDay(Number(year[1]), month, date) : upcoming(today, month, date);
      return day === null ? null : { length: 2 + of + (year ? 1 : 0), day };
    }
  }
  const month = monthOf(bare(token), lang, phrase);
  if (month && (lang.monthFirst || phrase)) {
    const date = /^(\d{1,2})(?:st|nd|rd|th)?,?$/.exec(tokens[i + 1]?.word ?? "");
    if (date) {
      const year = YEAR.exec(word(2));
      const day = year ? calendarDay(Number(year[1]), month, Number(date[1])) : upcoming(today, month, Number(date[1]));
      return day === null ? null : { length: 2 + (year ? 1 : 0), day };
    }
  }
  return null;
}

/** A date at `i`, with an article before it ("on friday") and a particle after it ("金曜日までに") taken along. */
export function dateFrom(tokens: Token[], i: number, lang: Language, today: number, rules: ReadRules = {}): Found | null {
  const article = phraseAt(tokens, i, lang.vocabulary.articles);
  const afterArticle = article && i + article < tokens.length ? dateAt(tokens, i + article, lang, today, rules) : null;
  const found = afterArticle ? { ...afterArticle, length: afterArticle.length + article } : dateAt(tokens, i, lang, today, rules);
  if (!found) return null;
  return { ...found, length: found.length + phraseAt(tokens, i + found.length, lang.vocabulary.particles ?? []) };
}

/**
 * The day (a day number) `text` names on its own, all of it and nothing else, read in the
 * interface language and in English, past dates too; null when it names none.
 */
export function readDay(text: string, locale: string, today: number, rules: Omit<ReadRules, "past"> = {}): number | null {
  const tokens = tokenize(text.trim(), isGlued(locale));
  if (!tokens.length) return null;
  for (const lang of languagesFor(locale)) {
    const found = dateFrom(readAs(tokens, lang), 0, lang, today, { ...rules, past: true });
    if (found && found.length === tokens.length) return found.day;
  }
  return null;
}

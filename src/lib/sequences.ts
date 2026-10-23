import { checkEmailDraft, type EmailDraftProblem } from "./email-draft-check";
import { dayNumber, dayString, localDay, weekdayOf, zonedInstant } from "./time-zone";

/**
 * Follow-up sequences on the rows of a mail database (server/sequences): a name and steps, each an
 * email some days after the one before (the first, after the row is enrolled), written with the
 * row's values (`{{Contact person | there}}`) and sent from the enrolling member's own mailbox, on
 * its own or after they approve its draft under For review. Step 2 on answers in the thread of the
 * email before. An enrollment stops when the contact answers, and pauses on an out-of-office
 * reply until they are back. Pure and client-safe: the types, limits and templates, out-of-office
 * detection and when a step may go out.
 */

/** "Send on its own", or "ask me first": the draft waits in the sender's For review queue. */
export const SEQUENCE_STEP_MODES = ["auto", "review"] as const;
export type SequenceStepMode = (typeof SEQUENCE_STEP_MODES)[number];

/**
 * One email of a sequence: `days` after the email before (after enrolling, for the first; 0 is
 * at once), in `mode`. Only the first step has a subject: later steps answer in its thread
 * ("Re: …").
 */
export type SequenceStep = { id: string; days: number; subject: string; text: string; mode: SequenceStepMode };

/** When a sequence's emails may go out: on these weekdays (0 Sunday … 6 Saturday), from `start` to `end` minutes past midnight, in the sender's time zone. */
export type SendWindow = { days: number[]; start: number; end: number };

export const DEFAULT_SEND_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
/** Sequence emails a mailbox sends at most a day, all sequences together, unless its owner sets another number. */
export const DEFAULT_DAILY_LIMIT = 50;
export const MAX_DAILY_LIMIT = 500;
/** The gap between two sequence emails from one mailbox: at random between these (seconds). */
export const SPREAD_SECONDS = [120, 420] as const;
/** How long an out-of-office reply pauses an enrollment when it gives no date to be back by. */
export const OUT_OF_OFFICE_DAYS = 7;
/** A return date further out than this is taken for a misreading: the default pause applies. */
export const MAX_OUT_OF_OFFICE_DAYS = 120;
/** How long finished and stopped enrollments are kept, for the row's history and the API. */
export const ENROLLMENT_HISTORY_DAYS = 90;
export const MAX_SEQUENCES = 50;
export const MAX_SEQUENCE_STEPS = 10;
export const MAX_STEP_DAYS = 90;
export const MAX_SEQUENCE_NAME = 120;
export const MAX_STEP_SUBJECT = 300;
export const MAX_STEP_TEXT = 20_000;
/** Rows one bulk enrollment takes at most (a table selection, the API). */
export const MAX_BULK_ENROLL = 200;

/**
 * Where an enrollment stands: going (`active`, its next step due at `nextAt`), waiting for its
 * sender to approve a step's draft (`waiting`), held (`paused`, see PauseReason), through all its
 * steps (`finished`), or ended early (`stopped`, see StopReason).
 */
export const ENROLLMENT_STATUSES = ["active", "waiting", "paused", "finished", "stopped"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
/** Enrollments that still go on: a row has at most one of these per sequence. */
export const OPEN_ENROLLMENT = ["active", "waiting", "paused"] as const satisfies readonly EnrollmentStatus[];
export const isOpenEnrollment = (status: string) => (OPEN_ENROLLMENT as readonly string[]).includes(status);

/** Why an enrollment is paused: an out-of-office reply (until `pausedUntil`), or an email that didn't pass the draft check. */
export const PAUSE_REASONS = ["outOfOffice", "checkFailed"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
/**
 * Why an enrollment stopped: the contact answered; someone stopped it; its row went to the trash;
 * the sender's mailbox was disconnected, they may no longer write on the row, or email on rows was
 * turned off; the sender dismissed a step's draft or let it expire; the row has no address to
 * write to.
 */
export const STOP_REASONS = [
  "replied",
  "manual",
  "rowTrashed",
  "mailboxDisconnected",
  "noAccess",
  "emailOff",
  "dismissed",
  "draftExpired",
  "noAddress",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export type EnrollmentReason = PauseReason | StopReason;

/** How an enrollment was started, for its history. */
export const ENROLLMENT_SOURCES = ["row", "bulk", "automation", "mcp", "api"] as const;
export type EnrollmentSource = (typeof ENROLLMENT_SOURCES)[number];

/** An enrollment as the row, MCP and the REST API show it. */
export type EnrollmentView = {
  id: string;
  workspaceId: string;
  sequence: { id: string; name: string };
  row: { id: string; title: string };
  databaseId: string;
  sender: { id: string; name: string };
  status: EnrollmentStatus;
  /** The step it is on (1-based): the next to go out, the one waiting for review, or for a finished one the last. */
  step: number;
  steps: number;
  /** Emails it has sent so far. */
  sent: number;
  /** When the next step goes out, at the earliest (the send window and the daily limit may hold it later). */
  nextAt: string | null;
  pausedUntil: string | null;
  reason: EnrollmentReason | null;
  /** checkFailed: what the draft check found. */
  problems: EmailDraftProblem[] | null;
  /** waiting: the draft in the sender's For review queue. */
  reviewChangeId: string | null;
  source: EnrollmentSource;
  startedAt: string;
  endedAt: string | null;
  /** The viewer may stop it (whoever may edit the row) and resume it (its sender, when it is paused). */
  canStop: boolean;
  canResume: boolean;
};

/** A sequence as its editor, the row's "Start follow-up" and the API show it. */
export type SequenceView = {
  id: string;
  workspaceId: string;
  databaseId: string;
  name: string;
  steps: SequenceStep[];
  window: SendWindow;
  /** Enrollments still going. */
  open: number;
  updatedAt: string;
};

/** A step of a draft that a sequence put in the For review queue, as the queue shows it. */
export type SequenceDraftInfo = { sequenceId: string; name: string; enrollmentId: string; step: number; steps: number };

// --------------------------------------------------------------------------------- templates

/** A variable in a step: `{{Name}}`, or as every one must be, `{{Name | fallback}}`. */
const VARIABLE = /\{\{([^{}]*)\}\}/g;

export type SequenceVariable = { name: string; fallback: string | null; raw: string };

function splitVariable(inside: string) {
  const bar = inside.indexOf("|");
  return { name: (bar === -1 ? inside : inside.slice(0, bar)).trim(), fallback: bar === -1 ? null : inside.slice(bar + 1).trim() };
}

/** The variables of a text, in order, as written. */
export function sequenceVariables(text: string): SequenceVariable[] {
  return [...text.matchAll(VARIABLE)].map((m) => ({ ...splitVariable(m[1]), raw: m[0] }));
}

/** Variables every row has besides its properties: its title (as Name or Title), and the sender's name. */
export const BUILTIN_VARIABLES = ["Name", "Title", "Sender"] as const;

export type TemplateProblem = { problem: "empty"; name: string } | { problem: "noFallback"; name: string } | { problem: "unknown"; name: string };

/**
 * What is wrong with a step's text as typed: a variable without a name; without a fallback (an
 * empty value would leave a hole: "Hello ,"); or naming no property of the database (`names`,
 * matched without regard to case; the builtin ones count).
 */
export function templateProblems(text: string, names: string[]): TemplateProblem[] {
  const known = new Set([...names, ...BUILTIN_VARIABLES].map((n) => n.toLowerCase()));
  const out: TemplateProblem[] = [];
  for (const v of sequenceVariables(text)) {
    if (!v.name) out.push({ problem: "empty", name: v.raw });
    else if (!v.fallback) out.push({ problem: "noFallback", name: v.name });
    else if (!known.has(v.name.toLowerCase())) out.push({ problem: "unknown", name: v.name });
  }
  return out;
}

/**
 * Text with its variables written in from `values` (by name, without regard to case, each on one
 * line): an empty or missing value takes the variable's fallback. `fallbacks` lists the variables
 * that did.
 */
export function renderTemplate(text: string, values: Record<string, string>): { text: string; fallbacks: string[] } {
  const byName = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const fallbacks: string[] = [];
  const out = text.replace(VARIABLE, (_whole, inside: string) => {
    const { name, fallback } = splitVariable(inside);
    const value = (byName.get(name.toLowerCase()) ?? "").replace(/\s+/g, " ").trim();
    if (value) return value;
    fallbacks.push(name);
    return fallback ?? "";
  });
  return { text: out, fallbacks };
}

/**
 * What the draft check finds in a step as written, each variable at its fallback: Markdown, HTML,
 * gaps to fill or the app's own links in the template itself, which every email of it would carry.
 */
export function stepDraftProblems(step: { subject: string; text: string }, first: boolean): EmailDraftProblem[] {
  const subject = first ? renderTemplate(step.subject, {}).text : "Re: subject";
  const check = checkEmailDraft({ subject, text: renderTemplate(step.text, {}).text });
  return check.ok ? [] : check.problems.map((p) => p.problem);
}

// ----------------------------------------------------------------------------- out of office

/**
 * Subjects of out-of-office replies, in the languages people write them in. Bounces and
 * newsletters are automatic too, but don't say the person is away.
 */
const OUT_OF_OFFICE_SUBJECT = new RegExp(
  [
    "out of (the )?office",
    "\\booo\\b",
    "automatic reply",
    "auto[- ]?reply",
    "auto[- ]?response",
    "away from (the )?office",
    "on (vacation|holiday|leave)",
    "abwesenheit",
    "automatische antwort",
    "nicht im b(ü|ue)ro",
    "r(é|e)ponse automatique",
    "absente? du bureau",
    "respuesta autom(á|a)tica",
    "fuera de (la )?oficina",
    "risposta automatica",
    "fuori (sede|ufficio)",
    "resposta autom(á|a)tica",
    "fora do escrit(ó|o)rio",
    "otomatik (yan(ı|i)t|cevap)",
    "ofis d(ı|i)ş(ı|i)nda",
    "izindeyim",
    "automatisch antwoord",
    "afwezig",
    "automatyczna odpowied(ź|z)",
    "nieobecno(ś|s)(ć|c)",
    "автоответ",
    "автоматический ответ",
    "вне офиса",
    "в отпуске",
    "自动回复",
    "自動回覆",
    "自動返信",
    "不在",
    "자동 ?회신",
    "자동 ?응답",
    "부재",
  ].join("|"),
  "i",
);

/** The headers and subject an out-of-office check looks at. */
export type AutoReplySignals = {
  autoSubmitted?: string | null;
  precedence?: string | null;
  xAutoreply?: string | null;
  xAutorespond?: string | null;
  subject?: string | null;
};

/**
 * Whether a message is an out-of-office reply: its headers say a machine answered
 * (`Auto-Submitted: auto-replied`, `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply`), or
 * its subject reads like one.
 */
export function isOutOfOffice(signals: AutoReplySignals): boolean {
  const auto = signals.autoSubmitted?.trim().toLowerCase() ?? "";
  if (auto.startsWith("auto-replied")) return true;
  const flag = (value: string | null | undefined) => typeof value === "string" && !/^\s*(no|false|0)?\s*$/i.test(value);
  if (flag(signals.xAutoreply) || flag(signals.xAutorespond)) return true;
  if (/^\s*auto[_-]reply\s*$/i.test(signals.precedence ?? "")) return true;
  return OUT_OF_OFFICE_SUBJECT.test(signals.subject ?? "");
}

/**
 * Month names and their usual short forms, in the languages out-of-office replies come in
 * (English, German, Dutch, French, Spanish, Italian, Portuguese, Turkish, Polish, Russian), in
 * the forms dates take ("marca", "марта"). Short forms that are everyday words too ("ago", "set",
 * "sie") are left out.
 */
const MONTH_WORDS: string[][] = [
  ["january", "jan", "januar", "jänner", "jän", "janvier", "janv", "enero", "ene", "gennaio", "gen", "janeiro", "januari", "ocak", "styczeń", "stycznia", "sty", "январь", "января", "янв"],
  ["february", "feb", "februar", "février", "fevrier", "févr", "fevr", "febrero", "febbraio", "fevereiro", "fev", "februari", "şubat", "subat", "luty", "lutego", "lut", "февраль", "февраля", "фев"],
  ["march", "mar", "märz", "maerz", "mär", "mars", "marzo", "março", "marco", "maart", "mart", "marzec", "marca", "март", "марта"],
  ["april", "apr", "avril", "avr", "abril", "abr", "aprile", "nisan", "kwiecień", "kwietnia", "kwi", "апрель", "апреля", "апр"],
  ["may", "mai", "mayo", "maggio", "mag", "maio", "mei", "mayıs", "mayis", "maj", "maja", "май", "мая"],
  ["june", "jun", "juni", "juin", "junio", "giugno", "giu", "junho", "haziran", "czerwiec", "czerwca", "cze", "июнь", "июня", "июн"],
  ["july", "jul", "juli", "juillet", "juil", "julio", "luglio", "lug", "julho", "temmuz", "lipiec", "lipca", "lip", "июль", "июля", "июл"],
  ["august", "aug", "août", "aout", "agosto", "augustus", "ağustos", "agustos", "sierpień", "sierpnia", "август", "августа", "авг"],
  ["september", "sep", "sept", "septembre", "septiembre", "settembre", "setembro", "eylül", "eylul", "wrzesień", "września", "wrz", "сентябрь", "сентября", "сен"],
  ["october", "oct", "oktober", "okt", "octobre", "octubre", "ottobre", "ott", "outubro", "ekim", "październik", "października", "paź", "октябрь", "октября", "окт"],
  ["november", "nov", "novembre", "noviembre", "novembro", "kasım", "kasim", "listopad", "listopada", "lis", "ноябрь", "ноября", "ноя"],
  ["december", "dec", "dezember", "dez", "décembre", "decembre", "déc", "diciembre", "dic", "dicembre", "dezembro", "aralık", "aralik", "grudzień", "grudnia", "gru", "декабрь", "декабря", "дек"],
];
const MONTH_OF = new Map(MONTH_WORDS.flatMap((words, i) => words.map((w) => [w, i + 1] as const)));
const monthOf = (word: string) => MONTH_OF.get(word.toLowerCase().replace(/\.$/, "")) ?? null;

/** Words that say the date after them is the day they are back ("back on", "zurück am"). */
const BACK_WORDS =
  /(back|return|returning|zur(ü|ue)ck|wieder da|wieder im|retour|de vuelta|regreso|regresar(é|e)|rientro|ritorno|volta|regresso|d(ö|o)n(ü|u)ş|d(ö|o)nece(ğ|g)im|terug|wracam|powr(ó|o)t|вернусь|возвращ)/i;

const LETTERS = "a-zà-ÿçğışöüłąęńóśźżа-яё";
const NUMERIC = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g;
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er|\\.)?\\s*(?:of\\s+|de\\s+)?([${LETTERS}]{3,}\\.?)(?:,?\\s*(\\d{4}))?`, "giu");
const MONTH_DAY = new RegExp(`(?<![${LETTERS}])([${LETTERS}]{3,}\\.?)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, "giu");

/** A message's own words: without the lines it quotes, nor the message it answers (whose dates aren't theirs). */
export function ownWords(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const end = lines.findIndex((line) => /^-{2,}\s*(original|ursprüngliche|message d'origine|mensaje original|messaggio originale|orijinal)/i.test(line.trim()) || /\bwrote:\s*$|schrieb:\s*$|a écrit\s*:\s*$|escribió:\s*$|yazdı:\s*$/i.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).filter((line) => !line.startsWith(">")).join("\n");
}

/**
 * The day an out-of-office reply says the person is back, YYYY-MM-DD in `timeZone`: from the
 * latest date its own words name in the coming MAX_OUT_OF_OFFICE_DAYS ("until 14 March": the
 * 15th; "back on 14 March": the 14th). Dates read: 2026-03-14, 14.03.2026, 14.03., 14/03(/2026)
 * (the day first, unless only the month first makes a date), "14 March 2026", "March 14th",
 * "14. März", "14 de marzo", in the languages of MONTH_WORDS. Null when it names none.
 */
export function parseReturnDate(text: string, now: Date, timeZone: string): string | null {
  const words = ownWords(text);
  const today = localDay(now.getTime(), timeZone);
  const thisYear = Number(dayString(today).slice(0, 4));
  const found: { day: number; back: boolean }[] = [];
  const consider = (year: number | null, month: number, day: number, index: number, length: number) => {
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return;
    const build = (y: number) => {
      const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      // The 31st of February and the like don't come back the same.
      return dayString(dayNumber(iso)) === iso ? dayNumber(iso) : null;
    };
    let at = build(year === null ? thisYear : year < 100 ? 2000 + year : year);
    // Without a year, a day well past is next year's.
    if (year === null && (at === null || at < today - 1)) at = build(thisYear + 1);
    if (at === null || at < today || at > today + MAX_OUT_OF_OFFICE_DAYS) return;
    // "Back on the 5th", or "am 5.11. wieder im Büro".
    const near = `${words.slice(Math.max(0, index - 30), index)} ${words.slice(index + length, index + length + 12)}`;
    found.push({ day: at, back: BACK_WORDS.test(near) });
  };
  for (const m of words.matchAll(NUMERIC)) {
    if (m[1]) {
      consider(Number(m[1]), Number(m[2]), Number(m[3]), m.index, m[0].length);
      continue;
    }
    // Without a year, only "14.03." and "14/03" are dates: "9.30" is a time, "3-4" a range.
    const after = words[m.index + m[0].length];
    if (!m[6] && !m[0].includes("/") && after !== ".") continue;
    const [a, b] = [Number(m[4]), Number(m[5])];
    const year = m[6] ? Number(m[6]) : null;
    if (b > 12 && a <= 12) consider(year, a, b, m.index, m[0].length);
    else consider(year, b, a, m.index, m[0].length);
  }
  for (const m of words.matchAll(DAY_MONTH)) {
    const month = monthOf(m[2]);
    if (month) consider(m[3] ? Number(m[3]) : null, month, Number(m[1]), m.index, m[0].length);
  }
  for (const m of words.matchAll(MONTH_DAY)) {
    const month = monthOf(m[1]);
    if (month) consider(m[3] ? Number(m[3]) : null, month, Number(m[2]), m.index, m[0].length);
  }
  if (!found.length) return null;
  const latest = found.reduce((a, b) => (b.day > a.day || (b.day === a.day && b.back) ? b : a));
  return dayString(latest.back ? latest.day : latest.day + 1);
}

// ------------------------------------------------------------------------------- send slots

const DAY_MS = 86_400_000;

/** Minutes past midnight of an instant in `timeZone`. */
function minutesOf(instant: number, timeZone: string) {
  return Math.floor((instant - zonedInstant(localDay(instant, timeZone), 0, timeZone)) / 60_000);
}

/**
 * The earliest instant at or after `due` (and `now`, and `notBefore`: the mailbox's spread) when a
 * step may go out: within the send window in `timeZone`, on a day the mailbox hasn't reached
 * `dailyLimit` (`sentToday` counts today's in that zone; a later day starts at none). Looks two
 * weeks ahead at most; null when nothing fits (a window without days).
 */
export function nextSendSlot({
  due,
  now,
  notBefore = 0,
  window,
  timeZone,
  sentToday,
  dailyLimit,
}: {
  due: number;
  now: number;
  notBefore?: number;
  window: SendWindow;
  timeZone: string;
  sentToday: number;
  dailyLimit: number;
}): number | null {
  if (!window.days.length || window.end <= window.start) return null;
  const today = localDay(now, timeZone);
  let at = Math.max(due, now, notBefore);
  for (let i = 0; i < 32; i++) {
    const day = localDay(at, timeZone);
    if (day > today + 14) return null;
    const minutes = minutesOf(at, timeZone);
    if ((day === today && sentToday >= dailyLimit) || !window.days.includes(weekdayOf(day)) || minutes >= window.end) {
      at = zonedInstant(day + 1, 0, timeZone);
      continue;
    }
    return minutes < window.start ? zonedInstant(day, window.start, timeZone) : at;
  }
  return null;
}

/** A random gap before a mailbox's next sequence email (SPREAD_SECONDS), in milliseconds. */
export const spreadMs = (random = Math.random) => Math.round((SPREAD_SECONDS[0] + random() * (SPREAD_SECONDS[1] - SPREAD_SECONDS[0])) * 1000);

/** When a step is due: `days` after `from`. */
export const stepDue = (from: number, days: number) => from + days * DAY_MS;

/** A send window as typed, checked: weekdays 0–6 (each once), whole minutes, the end after the start. Null when it isn't one. */
export function checkWindow(value: unknown): SendWindow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.days) || !Number.isInteger(v.start) || !Number.isInteger(v.end)) return null;
  const days = [...new Set(v.days)].filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6).sort((a, b) => a - b);
  const start = v.start as number;
  const end = v.end as number;
  if (!days.length || days.length !== v.days.length || start < 0 || end > 24 * 60 || end <= start) return null;
  return { days, start, end };
}

// Client-safe: quizzes on pages (server/quizzes.ts), their questions, how they are checked and how
// an attempt is scored. The block that shows one is lib/quiz-block.ts.

/**
 * A quiz's question: one right option (`single`) or one or more (`multiple`). `correct` and
 * `explanation` are the quiz's secret: they reach only people who may edit the page, and a reader
 * once they passed or have no attempts left (server/quizzes.ts).
 */
export type QuizKind = "single" | "multiple";

export type QuizOption = { id: string; text: string };

export type QuizQuestion = {
  id: string;
  text: string;
  kind: QuizKind;
  options: QuizOption[];
  correct: string[];
  explanation: string;
};

/** A question as a reader sees it before the answers are shown: no right answers, no explanation. */
export type QuizQuestionView = Omit<QuizQuestion, "correct" | "explanation"> & { correct?: string[]; explanation?: string };

/** What a quiz holds besides its page: the questions, the pass mark in percent and the attempts allowed (null: any number). */
export type QuizSettings = { questions: QuizQuestion[]; passMark: number; maxAttempts: number | null };

/** A reader's answers: for each question's id, the ids of the options they picked. */
export type QuizAnswers = Record<string, string[]>;

export const MAX_QUESTIONS = 50;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_TEXT = 200;
export const MAX_EXPLANATION = 500;
export const DEFAULT_PASS_MARK = 80;
/** The most attempts a quiz may limit people to; beyond it, "any number" says the same. */
export const MAX_ATTEMPTS_LIMIT = 100;
/** The most people asked to take a quiz at once. */
export const MAX_ASSIGN = 200;

/** Why a quiz's settings can't be saved; `question` is the 0-based index of the question at fault. */
export type QuizSettingsError =
  | { code: "tooManyQuestions" | "passMark" | "maxAttempts" | "invalid" }
  | { code: "questionText" | "options" | "optionText" | "correct" | "explanation"; question: number };

const ID = /^[\w-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A new id for a question or an option. */
export const newQuizItemId = () => crypto.randomUUID().slice(0, 8);

/**
 * Checks a quiz's settings as an editor sends them and returns them cleaned: text trimmed, ids
 * checked and unique, the right answers among the options (exactly one for `single`, at least one
 * for `multiple`), the pass mark a whole percent and the attempts null or 1 to MAX_ATTEMPTS_LIMIT.
 */
export function checkQuiz(input: unknown): { ok: true; quiz: QuizSettings } | { ok: false; error: QuizSettingsError } {
  if (!isRecord(input) || !Array.isArray(input.questions)) return { ok: false, error: { code: "invalid" } };
  if (input.questions.length > MAX_QUESTIONS) return { ok: false, error: { code: "tooManyQuestions" } };
  const passMark = input.passMark;
  if (typeof passMark !== "number" || !Number.isInteger(passMark) || passMark < 0 || passMark > 100) return { ok: false, error: { code: "passMark" } };
  const maxAttempts = input.maxAttempts ?? null;
  if (maxAttempts !== null && (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS_LIMIT)) {
    return { ok: false, error: { code: "maxAttempts" } };
  }
  const questions: QuizQuestion[] = [];
  const questionIds = new Set<string>();
  for (const [index, raw] of input.questions.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || questionIds.has(raw.id)) return { ok: false, error: { code: "invalid" } };
    questionIds.add(raw.id);
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text || text.length > MAX_QUESTION_TEXT) return { ok: false, error: { code: "questionText", question: index } };
    const kind: QuizKind | null = raw.kind === "multiple" || raw.kind === "single" ? raw.kind : null;
    if (!kind) return { ok: false, error: { code: "invalid" } };
    if (!Array.isArray(raw.options) || raw.options.length < MIN_OPTIONS || raw.options.length > MAX_OPTIONS) return { ok: false, error: { code: "options", question: index } };
    const options: QuizOption[] = [];
    const optionIds = new Set<string>();
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.id !== "string" || !ID.test(option.id) || optionIds.has(option.id)) return { ok: false, error: { code: "invalid" } };
      optionIds.add(option.id);
      const optionText = typeof option.text === "string" ? option.text.trim() : "";
      if (!optionText || optionText.length > MAX_OPTION_TEXT) return { ok: false, error: { code: "optionText", question: index } };
      options.push({ id: option.id, text: optionText });
    }
    const correct = Array.isArray(raw.correct) ? [...new Set(raw.correct.filter((id): id is string => typeof id === "string"))] : [];
    if (!correct.length || correct.some((id) => !optionIds.has(id)) || (kind === "single" && correct.length !== 1)) {
      return { ok: false, error: { code: "correct", question: index } };
    }
    const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : "";
    if (explanation.length > MAX_EXPLANATION) return { ok: false, error: { code: "explanation", question: index } };
    // In the options' order, so two saves of the same answers are the same.
    questions.push({ id: raw.id, text, kind, options, correct: options.filter((o) => correct.includes(o.id)).map((o) => o.id), explanation });
  }
  return { ok: true, quiz: { questions, passMark, maxAttempts } };
}

/** The questions as stored, read defensively (an empty list for anything else). */
export function storedQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (q): q is QuizQuestion =>
      isRecord(q) && typeof q.id === "string" && typeof q.text === "string" && Array.isArray(q.options) && Array.isArray(q.correct),
  );
}

/** The questions without what only editors (and readers who are done) may see. */
export const withoutAnswers = (questions: QuizQuestion[]): QuizQuestionView[] =>
  questions.map(({ id, text, kind, options }) => ({ id, text, kind, options: options.map((o) => ({ id: o.id, text: o.text })) }));

/**
 * A reader's answers as sent, kept to the quiz's questions and options: unknown ids dropped,
 * duplicates once, at most one option for a `single` question.
 */
export function cleanAnswers(questions: QuizQuestion[], input: unknown): QuizAnswers {
  const out: QuizAnswers = {};
  if (!isRecord(input)) return out;
  for (const question of questions) {
    const raw = input[question.id];
    if (!Array.isArray(raw)) continue;
    const known = new Set(question.options.map((o) => o.id));
    const picked = [...new Set(raw.filter((id): id is string => typeof id === "string" && known.has(id)))];
    if (picked.length) out[question.id] = question.kind === "single" ? picked.slice(0, 1) : picked;
  }
  return out;
}

/**
 * Scores an attempt: a question counts only when exactly its right options were picked (all of them
 * and nothing else, for `multiple`). Returns the ids of the questions answered right and the score
 * in whole percent (0 for a quiz without questions).
 */
export function scoreAnswers(questions: QuizQuestion[], answers: QuizAnswers): { right: string[]; score: number } {
  const right = questions
    .filter((q) => {
      const picked = answers[q.id] ?? [];
      return picked.length === q.correct.length && picked.every((id) => q.correct.includes(id));
    })
    .map((q) => q.id);
  return { right, score: questions.length ? Math.round((right.length / questions.length) * 100) : 0 };
}

export const passes = (score: number, passMark: number) => score >= passMark;

/** Whether the person is done: they passed, or used every attempt the quiz allows. */
export const quizDone = (passed: boolean, attempts: number, maxAttempts: number | null) => passed || (maxAttempts !== null && attempts >= maxAttempts);

/** Attempts left, or null for any number. */
export const attemptsLeft = (attempts: number, maxAttempts: number | null) => (maxAttempts === null ? null : Math.max(0, maxAttempts - attempts));

/** A due date (YYYY-MM-DD) passed without a pass, as of `today` (YYYY-MM-DD, the viewer's own day). */
export const isOverdue = (due: string | null, passed: boolean, today: string) => due !== null && !passed && due < today;

/** A day as YYYY-MM-DD, or null. */
export function parseDueDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

/** A blank question for the editor. */
export function blankQuestion(kind: QuizKind = "single"): QuizQuestion {
  return { id: newQuizItemId(), text: "", kind, options: [0, 1].map(() => ({ id: newQuizItemId(), text: "" })), correct: [], explanation: "" };
}

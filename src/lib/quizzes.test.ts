import { describe, expect, it } from "vitest";
import { attemptsLeft, checkQuiz, cleanAnswers, isOverdue, parseDueDate, quizDone, scoreAnswers, withoutAnswers, type QuizQuestion } from "./quizzes";
import { mapQuizLines, parseQuizLine, parseQuizNotice, quizLine, quizNoticeMessage } from "./quiz-block";

const single: QuizQuestion = {
  id: "q1",
  text: "Where is the fire exit?",
  kind: "single",
  options: [
    { id: "a", text: "Left" },
    { id: "b", text: "Right" },
  ],
  correct: ["b"],
  explanation: "Signs point right.",
};
const multiple: QuizQuestion = {
  id: "q2",
  text: "Which are required?",
  kind: "multiple",
  options: [
    { id: "a", text: "Helmet" },
    { id: "b", text: "Gloves" },
    { id: "c", text: "Hat" },
  ],
  correct: ["a", "b"],
  explanation: "",
};

describe("checkQuiz", () => {
  const valid = { questions: [single, multiple], passMark: 80, maxAttempts: 3 };

  it("accepts a valid quiz and trims its text", () => {
    const result = checkQuiz({ ...valid, questions: [{ ...single, text: "  Where?  " }, multiple] });
    expect(result).toMatchObject({ ok: true, quiz: { passMark: 80, maxAttempts: 3 } });
    if (result.ok) expect(result.quiz.questions[0].text).toBe("Where?");
  });

  it("keeps the right answers in the options' order", () => {
    const result = checkQuiz({ ...valid, questions: [{ ...multiple, correct: ["b", "a", "a"] }] });
    expect(result.ok && result.quiz.questions[0].correct).toEqual(["a", "b"]);
  });

  it("refuses what isn't a quiz", () => {
    expect(checkQuiz(null)).toEqual({ ok: false, error: { code: "invalid" } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, kind: "essay" }] })).toEqual({ ok: false, error: { code: "invalid" } });
    expect(checkQuiz({ ...valid, questions: [single, { ...multiple, id: "q1" }] })).toEqual({ ok: false, error: { code: "invalid" } });
  });

  it("says which question is wrong and why", () => {
    expect(checkQuiz({ ...valid, questions: [single, { ...multiple, text: " " }] })).toEqual({ ok: false, error: { code: "questionText", question: 1 } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, options: [single.options[0]] }] })).toEqual({ ok: false, error: { code: "options", question: 0 } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, correct: ["a", "b"] }] })).toEqual({ ok: false, error: { code: "correct", question: 0 } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, correct: ["z"] }] })).toEqual({ ok: false, error: { code: "correct", question: 0 } });
    expect(checkQuiz({ ...valid, questions: [{ ...multiple, correct: [] }] })).toEqual({ ok: false, error: { code: "correct", question: 0 } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, explanation: "x".repeat(501) }] })).toEqual({ ok: false, error: { code: "explanation", question: 0 } });
    expect(checkQuiz({ ...valid, questions: [{ ...single, options: [{ id: "a", text: "" }, single.options[1]] }] })).toEqual({
      ok: false,
      error: { code: "optionText", question: 0 },
    });
  });

  it("checks the limits", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...single, id: `q${i}` }));
    expect(checkQuiz({ ...valid, questions: many })).toEqual({ ok: false, error: { code: "tooManyQuestions" } });
    expect(checkQuiz({ ...valid, passMark: 101 })).toEqual({ ok: false, error: { code: "passMark" } });
    expect(checkQuiz({ ...valid, passMark: 50.5 })).toEqual({ ok: false, error: { code: "passMark" } });
    expect(checkQuiz({ ...valid, maxAttempts: 0 })).toEqual({ ok: false, error: { code: "maxAttempts" } });
    expect(checkQuiz({ ...valid, maxAttempts: null })).toMatchObject({ ok: true, quiz: { maxAttempts: null } });
  });
});

describe("scoring", () => {
  it("counts a multiple-choice question only when exactly right", () => {
    expect(scoreAnswers([single, multiple], { q1: ["b"], q2: ["a", "b"] })).toEqual({ right: ["q1", "q2"], score: 100 });
    expect(scoreAnswers([single, multiple], { q1: ["b"], q2: ["a"] })).toEqual({ right: ["q1"], score: 50 });
    expect(scoreAnswers([single, multiple], { q1: ["b"], q2: ["a", "b", "c"] })).toEqual({ right: ["q1"], score: 50 });
    expect(scoreAnswers([single, multiple], {})).toEqual({ right: [], score: 0 });
    expect(scoreAnswers([], {})).toEqual({ right: [], score: 0 });
  });

  it("keeps answers to the quiz's questions and options", () => {
    expect(cleanAnswers([single, multiple], { q1: ["a", "b"], q2: ["a", "a", "zz", 3], q9: ["a"] })).toEqual({ q1: ["a"], q2: ["a"] });
    expect(cleanAnswers([single], "nope")).toEqual({});
  });

  it("strips the answers for readers", () => {
    const shown = withoutAnswers([single]);
    expect(shown[0]).not.toHaveProperty("correct");
    expect(shown[0]).not.toHaveProperty("explanation");
    expect(JSON.stringify(shown)).not.toContain("Signs point right");
  });

  it("knows when someone is done", () => {
    expect(quizDone(true, 1, null)).toBe(true);
    expect(quizDone(false, 5, null)).toBe(false);
    expect(quizDone(false, 3, 3)).toBe(true);
    expect(attemptsLeft(1, 3)).toBe(2);
    expect(attemptsLeft(4, 3)).toBe(0);
    expect(attemptsLeft(4, null)).toBeNull();
  });

  it("reads due dates", () => {
    expect(parseDueDate("2026-11-20")).toBe("2026-11-20");
    expect(parseDueDate("")).toBeNull();
    expect(parseDueDate(null)).toBeNull();
    expect(parseDueDate("2026-02-30")).toBeUndefined();
    expect(parseDueDate("tomorrow")).toBeUndefined();
    expect(isOverdue("2026-11-01", false, "2026-11-02")).toBe(true);
    expect(isOverdue("2026-11-02", false, "2026-11-02")).toBe(false);
    expect(isOverdue("2026-11-01", true, "2026-11-02")).toBe(false);
    expect(isOverdue(null, false, "2026-11-02")).toBe(false);
  });
});

describe("the block's Markdown", () => {
  it("reads and writes its line", () => {
    expect(parseQuizLine(quizLine("abc-1"))).toBe("abc-1");
    expect(parseQuizLine(quizLine(""))).toBe("");
    expect(parseQuizLine("<!-- leafdesk:agent-chat a -->")).toBeNull();
  });

  it("replaces lines outside code only", () => {
    const markdown = ["Intro", quizLine("q1"), "```", quizLine("q2"), "```"].join("\n");
    expect(mapQuizLines(markdown, (id) => `*${id}*`)).toBe(["Intro", "*q1*", "```", quizLine("q2"), "```"].join("\n"));
  });

  it("writes and reads the finished notice", () => {
    expect(parseQuizNotice(quizNoticeMessage({ score: 90, passed: true }))).toEqual({ score: 90, passed: true });
    expect(parseQuizNotice(quizNoticeMessage({ score: 40, passed: false }))).toEqual({ score: 40, passed: false });
    expect(parseQuizNotice("rows:3")).toBeNull();
  });
});

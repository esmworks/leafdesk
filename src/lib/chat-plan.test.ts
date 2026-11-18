import { describe, expect, it } from "vitest";
import { answered, answersMessage, lastProposal, planText, readProposal, readQuestions } from "./chat-plan";

const q = (question: string, options: unknown) => ({ question, options });

describe("reading the model's questions", () => {
  it("takes 1 to 4 questions with 2 to 4 options each", () => {
    const ok = readQuestions({ questions: [q(" Which   database? ", ["Tasks", "Projects"])] });
    expect(ok).toEqual({ ok: true, card: { kind: "questions", questions: [{ question: "Which database?", options: ["Tasks", "Projects"] }] } });
    expect(readQuestions({ questions: [] }).ok).toBe(false);
    expect(readQuestions({ questions: Array.from({ length: 5 }, () => q("a", ["b", "c"])) }).ok).toBe(false);
    expect(readQuestions({ questions: [q("a", ["only one"])] }).ok).toBe(false);
    expect(readQuestions({ questions: [q("a", ["1", "2", "3", "4", "5"])] }).ok).toBe(false);
    expect(readQuestions({ questions: [q("", ["1", "2"])] }).ok).toBe(false);
    expect(readQuestions({}).ok).toBe(false);
  });
});

describe("reading the model's plan", () => {
  it("needs a title and steps; risks are optional and capped", () => {
    const ok = readProposal({ title: "Clean up", steps: [{ what: "Archive old rows", where: "Tasks" }, "Rename the view"], risks: ["", "Rows are hidden", "a", "b", "c", "d", "e"] });
    expect(ok.ok && ok.card.steps).toEqual([{ what: "Archive old rows", where: "Tasks" }, { what: "Rename the view" }]);
    expect(ok.ok && ok.card.risks).toHaveLength(6);
    expect(readProposal({ title: "", steps: [{ what: "x" }] }).ok).toBe(false);
    expect(readProposal({ title: "t", steps: [] }).ok).toBe(false);
    expect(readProposal({ title: "t", steps: Array.from({ length: 13 }, () => ({ what: "x" })) }).ok).toBe(false);
  });

  it("is kept as text the conversation and the model read", () => {
    const read = readProposal({ title: "Clean up", steps: [{ what: "Archive old rows", where: "Tasks" }], risks: ["Rows are hidden"] });
    expect(read.ok && planText(read.card)).toBe("Plan: Clean up\n1. Archive old rows (Tasks)\nRisks:\n- Rows are hidden");
  });
});

describe("answers to the questions", () => {
  const card = { kind: "questions" as const, questions: [{ question: "Where?", options: ["Tasks", "Projects"] }, { question: "Name?", options: ["A", "B"] }] };
  it("needs every question answered, the person's own words winning over an option", () => {
    expect(answered(card, [{ option: 0, text: "" }, { option: null, text: "" }])).toBe(false);
    const both = [{ option: 1, text: "" }, { option: 0, text: " Mine " }];
    expect(answered(card, both)).toBe(true);
    expect(answersMessage(card, both)).toBe("Where?\n→ Projects\n\nName?\n→ Mine");
  });
});

describe("the plan to run", () => {
  it("is the proposal of the conversation's last answer, and only that", () => {
    const proposal = { kind: "proposal", title: "t", steps: [{ what: "x" }], risks: [] };
    expect(lastProposal([{ role: "user" }, { role: "assistant", steps: [proposal] }])).toEqual(proposal);
    expect(lastProposal([{ role: "assistant", steps: [proposal] }, { role: "user" }])).toBeNull();
    expect(lastProposal([{ role: "user" }, { role: "assistant", steps: [{ kind: "questions" }] }])).toBeNull();
    expect(lastProposal([])).toBeNull();
  });
});

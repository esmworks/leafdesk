/**
 * Plan first, the AI chat's mode for big changes: the model only reads, then ends its turn with
 * questions for the person (`ask_questions`) or a plan to approve (`propose_plan`). The pure part
 * shared by the server (server/ai-chat-plan.ts: the tools, what ends a turn) and the cards: the
 * limits, reading the model's arguments, the turn's text and the message that answers questions.
 */
import type { ChatProposalRecord, ChatQuestionsRecord } from "@/db/schema/ai";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_PLAN_STEPS = 12;
export const MAX_RISKS = 6;
const QUESTION_CHARS = 300;
const OPTION_CHARS = 120;
const TITLE_CHARS = 160;
const STEP_CHARS = 400;
const WHERE_CHARS = 160;
const RISK_CHARS = 300;

export const ASK_QUESTIONS_NAME = "ask_questions";
export const PROPOSE_PLAN_NAME = "propose_plan";
export const isPlanCall = (name: string) => name === ASK_QUESTIONS_NAME || name === PROPOSE_PLAN_NAME;

/** What ends a planning turn, as the turn records it. */
export type PlanCard = ChatQuestionsRecord | ChatProposalRecord;
export const isPlanCard = (step: { kind: string }): step is PlanCard => step.kind === "questions" || step.kind === "proposal";

const clean = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The questions the model asked, or why they don't do (said back to the model). */
export function readQuestions(args: Record<string, unknown>): { ok: true; card: ChatQuestionsRecord } | { ok: false; error: string } {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  if (raw.length < 1 || raw.length > MAX_QUESTIONS) return { ok: false, error: `${ASK_QUESTIONS_NAME} takes 1 to ${MAX_QUESTIONS} questions.` };
  const questions: ChatQuestionsRecord["questions"] = [];
  for (const entry of raw) {
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const question = clean(item.question, QUESTION_CHARS);
    const options = (Array.isArray(item.options) ? item.options : []).map((o) => clean(o, OPTION_CHARS)).filter(Boolean);
    if (!question || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { ok: false, error: `Each question needs its text and ${MIN_OPTIONS} to ${MAX_OPTIONS} short options.` };
    }
    questions.push({ question, options });
  }
  return { ok: true, card: { kind: "questions", questions } };
}

/** The plan the model proposed, or why it doesn't do. */
export function readProposal(args: Record<string, unknown>): { ok: true; card: ChatProposalRecord } | { ok: false; error: string } {
  const title = clean(args.title, TITLE_CHARS);
  const raw = Array.isArray(args.steps) ? args.steps : [];
  const steps: ChatProposalRecord["steps"] = [];
  for (const entry of raw) {
    // A step may be given as a plain string.
    const item = typeof entry === "string" ? { what: entry } : entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const what = clean(item.what, STEP_CHARS);
    const where = clean(item.where, WHERE_CHARS);
    if (what) steps.push({ what, ...(where ? { where } : {}) });
  }
  if (!title || steps.length < 1 || steps.length > MAX_PLAN_STEPS) return { ok: false, error: `${PROPOSE_PLAN_NAME} needs a title and 1 to ${MAX_PLAN_STEPS} steps.` };
  const risks = (Array.isArray(args.risks) ? args.risks : []).map((r) => clean(r, RISK_CHARS)).filter(Boolean).slice(0, MAX_RISKS);
  return { ok: true, card: { kind: "proposal", title, steps, risks } };
}

/** The card as the turn's text: what the conversation keeps and the model reads on the next turn. */
export function planText(card: PlanCard): string {
  if (card.kind === "questions") {
    return [
      "Questions before I plan:",
      ...card.questions.map((q, i) => `${i + 1}. ${q.question} (${q.options.join(" / ")})`),
    ].join("\n");
  }
  return [
    `Plan: ${card.title}`,
    ...card.steps.map((s, i) => `${i + 1}. ${s.what}${s.where ? ` (${s.where})` : ""}`),
    ...(card.risks.length ? ["Risks:", ...card.risks.map((r) => `- ${r}`)] : []),
  ].join("\n");
}

/** One question's answer: a picked option or the person's own words (own words win). */
export type QuestionAnswer = { option: number | null; text: string };

/** Whether every question has an answer. */
export const answered = (card: ChatQuestionsRecord, answers: readonly QuestionAnswer[]) =>
  card.questions.every((_, i) => answers[i] && (answers[i].text.trim() !== "" || answers[i].option !== null));

/** The message the answers go as: each question with its answer. */
export function answersMessage(card: ChatQuestionsRecord, answers: readonly QuestionAnswer[]): string {
  return card.questions
    .map((q, i) => {
      const a = answers[i];
      const text = a?.text.trim() || (a?.option !== null && a?.option !== undefined ? q.options[a.option] : "");
      return `${q.question}\n→ ${text}`;
    })
    .join("\n\n");
}

/** The plan to run: the proposal of the conversation's last answer (null: that answer proposed none). */
export function lastProposal(records: readonly { role: "user" | "assistant"; steps?: readonly { kind: string }[] }[]): ChatProposalRecord | null {
  const last = records[records.length - 1];
  if (!last || last.role !== "assistant") return null;
  return (last.steps?.find((s) => s.kind === "proposal") as ChatProposalRecord | undefined) ?? null;
}

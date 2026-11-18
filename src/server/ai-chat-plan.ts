/**
 * Plan first in the AI chat: for a big change the person turns it on in the box, and the turn only
 * reads. The model is offered the reads as in a chat that changes nothing, minus what keeps notes
 * or sets reminders, and two tools that end the turn: `ask_questions` (what it can't decide from
 * the workspace) and `propose_plan` (what changes where, and the risks). Its card is drawn in the
 * chat; "Run this plan" asks the next question (plan `run`, ai-chat.ts), where the changes are
 * offered again under the person's own mode and the plan is attached from the conversation.
 */
import type { AiTool } from "@/server/ai";
import { ASK_QUESTIONS_NAME, MAX_OPTIONS, MAX_PLAN_STEPS, MAX_QUESTIONS, MAX_RISKS, MIN_OPTIONS, planText, PROPOSE_PLAN_NAME, readProposal, readQuestions, type PlanCard } from "@/lib/chat-plan";
import type { ToolOutcome } from "@/server/ai-tools";

export const ASK_QUESTIONS_TOOL: AiTool = {
  name: ASK_QUESTIONS_NAME,
  description:
    "Asks the person clarifying questions before you plan, and ends the turn: they pick an option or write their own answer, and their answers come as the next message. Only for choices you can't make from the workspace (which database, what scope, which of two ways). Call it once, as the last thing in the turn.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: `1 to ${MAX_QUESTIONS} questions, in the language of the request.`,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, short." },
            options: { type: "array", items: { type: "string" }, description: `${MIN_OPTIONS} to ${MAX_OPTIONS} short answers to pick from, the most likely first.` },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const PROPOSE_PLAN_TOOL: AiTool = {
  name: PROPOSE_PLAN_NAME,
  description:
    "Proposes the plan for the change and ends the turn: the person sees it and decides whether to run it. Nothing has been changed. Call it once, as the last thing in the turn, never write the plan only as text.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the plan does, in a few words." },
      steps: {
        type: "array",
        description: `1 to ${MAX_PLAN_STEPS} steps in order: what changes, and where.`,
        items: {
          type: "object",
          properties: {
            what: { type: "string", description: "What this step does." },
            where: { type: "string", description: "The database, page or place it changes (its name), when there is one." },
          },
          required: ["what"],
          additionalProperties: false,
        },
      },
      risks: { type: "array", items: { type: "string" }, description: `Up to ${MAX_RISKS} things that could go wrong or can't be undone; none when there are none.` },
    },
    required: ["title", "steps"],
    additionalProperties: false,
  },
};

/** The names of what only a planning turn has. */
export const PLAN_TOOLS = [ASK_QUESTIONS_TOOL, PROPOSE_PLAN_TOOL];

/**
 * What a planning turn is offered, from the tools a chat that changes nothing has: no notes kept or
 * dropped, no reminders set or changed (they change things, however small), and the two that end
 * the turn.
 */
export function planningTools(base: readonly AiTool[], dropped: ReadonlySet<string>): AiTool[] {
  return [...base.filter((t) => !dropped.has(t.name)), ...PLAN_TOOLS];
}

/** The call ending the turn: its card and text, or what is wrong with it (the turn then goes on). */
export function endPlanTurn(call: { name: string; arguments: Record<string, unknown> }): { card: PlanCard; text: string } | ToolOutcome {
  const read = call.name === ASK_QUESTIONS_NAME ? readQuestions(call.arguments) : readProposal(call.arguments);
  if (!read.ok) return { content: read.error, isError: true };
  return { card: read.card, text: planText(read.card) };
}

/** What the model is told when the person runs the plan, with the plan itself. */
export function approvedPlanPrompt(plan: string): string {
  return [
    "<approved_plan>",
    plan,
    "</approved_plan>",
    "The person approved the plan above (your own, from the earlier answer) and asks you to run it now. Carry it out step by step with the tools, as far as it says; change nothing it doesn't mention, and when something doesn't fit what you find, stop and say so instead of improvising. Say briefly at the end what you did.",
  ].join("\n");
}

/** The rule of a planning turn, added to the chat's instructions. */
export const PLANNING_RULE = [
  "Plan first: the person wants to see a plan before anything is changed, so in this turn you have no tools that change anything (this is not their mode: don't tell them to change it).",
  "- Read what you need to know first (search_pages, read_page, query_database, find_tools).",
  `- When an open choice matters and the workspace doesn't settle it (which database, what to name it, how far it should go), call ${ASK_QUESTIONS_NAME} once with the 1 to ${MAX_QUESTIONS} questions that matter, each with ${MIN_OPTIONS} to ${MAX_OPTIONS} options: never ask what you can find out, and never ask in plain text.`,
  `- Otherwise call ${PROPOSE_PLAN_NAME}: a title, the steps in order (what changes, and where, naming the databases and pages), and the risks (what could go wrong or can't be undone). Never write the plan only as text.`,
  `- ${ASK_QUESTIONS_NAME} and ${PROPOSE_PLAN_NAME} end the turn: call one of them last, and nothing after it. If the request changes nothing (a question), just answer it.`,
].join("\n");

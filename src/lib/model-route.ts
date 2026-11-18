// Client-safe and import-free: picking the model of a turn under Auto (the AI chat's model picker,
// an agent's model setting), by a rule anyone can read and a test can pin down.

/** The model id the chat's picker gives Auto; never a real model's id (server/ai-chat.ts pickModel). */
export const AUTO_MODEL = "auto";

export const isAutoModel = (value: unknown): value is typeof AUTO_MODEL => value === AUTO_MODEL;

/** Why a turn goes to the main model; a turn without one goes to the fast model. */
export const ROUTE_REASONS = ["failed", "research", "plan", "deep", "files", "long", "history", "code", "steps", "list"] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

export const isRouteReason = (value: unknown): value is RouteReason => typeof value === "string" && (ROUTE_REASONS as readonly string[]).includes(value);

export type RouteInput = {
  /** The question's length in characters. */
  question: number;
  /** The question's text (code and lists are told from it). Empty when only files were sent. */
  text?: string;
  /** The conversation before the question, in characters. */
  history: number;
  /** Files attached to the question (images included). */
  files: number;
  research?: boolean;
  /** Plan first, or running an approved plan. */
  planning?: boolean;
  /** The person asked for deep thinking. */
  deep?: boolean;
  /** Turns of this answer that called tools so far. */
  round: number;
  /** The fast model failed on this answer, or ran out of room: the rest goes to the main one. */
  failed?: boolean;
};

export type RouteChoice = { tier: "fast" | "main"; reason: RouteReason | null };

/** Past this many characters a question isn't a quick one. */
export const LONG_QUESTION_CHARS = 700;
/** Past this much earlier conversation the cheap model loses the thread more often than it saves. */
export const LONG_HISTORY_CHARS = 12_000;
/** Turns that called tools the fast model gets before the answer moves to the main one. */
export const FAST_ROUNDS = 3;

/** A fenced block, or lines that read as code (statements ending in ; { }, arrows, imports). */
const CODE = /```|^\s*(?:import |export |const |let |function |class |def |SELECT |INSERT |UPDATE )|=>|[;{}]\s*$/m;
/** Four or more lines that are list items or numbered steps: a task, not a question. */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

export const looksLikeCode = (text: string) => CODE.test(text);

export function looksLikeList(text: string) {
  let items = 0;
  for (const line of text.split("\n")) if (LIST_ITEM.test(line) && ++items >= 4) return true;
  return false;
}

/**
 * The model of the next turn: the fast one for a short, simple question answered with a few tool
 * calls, the main one for what is long, has files, is research or a plan, asks for deep thinking,
 * reads like code or a task list, has gone on past `FAST_ROUNDS` turns of tool calls, or already
 * failed on the fast one. Checked in this order: the first that holds is the reason.
 */
export function routeModel(input: RouteInput): RouteChoice {
  const main = (reason: RouteReason): RouteChoice => ({ tier: "main", reason });
  if (input.failed) return main("failed");
  if (input.research) return main("research");
  if (input.planning) return main("plan");
  if (input.deep) return main("deep");
  if (input.files > 0) return main("files");
  if (input.question > LONG_QUESTION_CHARS) return main("long");
  if (input.history > LONG_HISTORY_CHARS) return main("history");
  if (input.text && looksLikeCode(input.text)) return main("code");
  if (input.text && looksLikeList(input.text)) return main("list");
  if (input.round >= FAST_ROUNDS) return main("steps");
  return { tier: "fast", reason: null };
}

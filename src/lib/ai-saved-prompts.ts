// Client-safe: the AI assistant's menu (components/page/ai-assist.tsx) and the server
// (server/ai-saved-prompts.ts) check saved prompts alike.

/**
 * Prompts people save to reuse in the editor's AI assistant: a name to pick it by and the
 * instruction itself, per person and workspace. Instructions the whole team shares are skills.
 */

/** The most prompts one person keeps in a workspace. */
export const MAX_SAVED_PROMPTS = 50;
/** The longest name, in characters. */
export const MAX_PROMPT_NAME = 80;
/** The longest prompt: as long as the assistant's instruction field takes. */
export const MAX_PROMPT_TEXT = 1000;

export type SavedPrompt = { id: string; name: string; prompt: string };

export type SavedPromptProblem = "emptyName" | "emptyPrompt" | "nameTooLong" | "promptTooLong";

/** A name as it is kept: one line, spaces folded; "" when there is none. */
export const cleanPromptName = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** A prompt as it is kept: trimmed, line breaks kept. */
export const cleanPromptText = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "");

/** What is wrong with a prompt to save (or rename), or null when it can be kept. */
export function savedPromptProblem(name: string, prompt?: string): SavedPromptProblem | null {
  if (!name) return "emptyName";
  if (name.length > MAX_PROMPT_NAME) return "nameTooLong";
  if (prompt === undefined) return null;
  if (!prompt) return "emptyPrompt";
  if (prompt.length > MAX_PROMPT_TEXT) return "promptTooLong";
  return null;
}

/** A name for a prompt being saved: its first words, cut at a word within MAX_PROMPT_NAME. */
export function suggestPromptName(prompt: string): string {
  const line = cleanPromptName(prompt);
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

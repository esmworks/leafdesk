import { parsePdfTheme, type PdfTheme } from "@/lib/pdf-themes";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { ownedLetterheadWorkspace } from "@/server/letterheads";
import { pdfThemeDoc } from "@/server/pdf-theme-docs";

/** The longest instruction an owner gives. */
export const MAX_THEME_INSTRUCTION = 1_000;

/** The theme JSON in a model's answer: the whole answer, or what a ```json fence holds. */
export function themeAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A letterhead's theme changed as its owner asks (`instruction`), from `current` (the theme being
 * edited, saved or not; null to write one from nothing), checked before it is offered: a theme
 * that doesn't pass goes back to the model once with what's wrong. Nothing is saved. Throws
 * LetterheadError("notFound") when `userId` doesn't own the letterhead, AiError when the workspace
 * has no AI or the model's answer holds no theme that passes.
 */
export async function suggestPdfTheme(
  userId: string,
  letterheadId: string,
  { current, instruction }: { current: unknown; instruction: string },
  { signal }: { signal?: AbortSignal } = {},
): Promise<PdfTheme> {
  const workspaceId = await ownedLetterheadWorkspace(userId, letterheadId);
  const asked = instruction.trim().slice(0, MAX_THEME_INSTRUCTION);
  if (!asked) throw new AiError("invalid", "Say how the theme should change");
  if (!(await aiAvailable(workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const system = [
    "You write PDF themes for Leafdesk, a workspace app: JSON documents that lay out the PDF files made from its pages. Answer with the whole theme as JSON and nothing else.",
    pdfThemeDoc(),
    "Change only what the person asks for and keep the rest as it is. Texts the person writes in the theme stay in their language.",
  ].join("\n\n");
  const messages: AiMessage[] = [
    {
      role: "user",
      content: `${current === null || current === undefined ? "There is no theme yet." : `The theme now:\n\n\`\`\`json\n${JSON.stringify(current)}\n\`\`\``}\n\nWhat to change:\n${asked}`,
    },
  ];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ feature: "pdf.theme", userId, workspaceId, system, messages, signal });
    const parsed = parsePdfTheme(themeAnswer(result.text));
    if (parsed.ok) return parsed.theme;
    problems = parsed.problems;
    messages.push(result.message, { role: "user", content: `That theme doesn't pass the checks:\n${problems.join("\n")}\n\nWrite the whole theme again so that it does: the JSON alone.` });
  }
  throw new AiError("invalid", `The AI's theme didn't pass the checks: ${problems.join("; ")}`);
}

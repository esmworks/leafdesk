/**
 * The editor's AI writing assistant (#40): runs an action on a selection or a page as the person
 * asking, and saves a history version before a suggestion is applied. Applying happens in the
 * person's editor, which is bound to the page's shared document, so everyone else sees the change
 * live and Undo takes it back (see components/page/ai-assist.tsx).
 */
import * as z from "zod";
import { EDITOR_ACTIONS, isAiLanguage, SELECTION_ACTIONS } from "@/lib/ai";
import { isPageLocked } from "@/lib/page-lock";
import { AccessError, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { aiConfig, AiError, stream, type AiStream } from "@/server/ai";
import { editorPrompt } from "@/server/ai/prompts";
import { getCollab } from "@/server/collab/bridge";
import { workspaceSettings } from "@/server/workspaces";

/** Whether AI features are available in a workspace: the server has a provider and owners left it on. */
export async function aiAvailable(workspaceId: string): Promise<boolean> {
  if (!aiConfig().chat) return false;
  return (await workspaceSettings(workspaceId)).ai !== false;
}

/** Room left for page content in a prompt after the instructions. */
const PROMPT_OVERHEAD = 1_500;
export const MAX_INSTRUCTION = 1_000;

export const editorActionInput = z.object({
  pageId: z.string().min(1).max(100),
  action: z.enum(EDITOR_ACTIONS),
  /** The selected text, as Markdown. */
  text: z.string().max(500_000).optional(),
  /** translate: the target language code. */
  language: z.string().max(20).optional(),
  /** custom: what to do. */
  instruction: z.string().max(MAX_INSTRUCTION).optional(),
  /** continue and custom without a selection: the page up to the cursor, as Markdown. */
  before: z.string().max(500_000).optional(),
});
export type EditorActionInput = z.infer<typeof editorActionInput>;

/** The page, when the person may edit it and the workspace has AI on; throws AiError otherwise. */
async function editablePage(userId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "edit").catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) throw new AiError("noAccess", "Page not found");
    throw error;
  });
  if (found.archivedAt || found.kind !== "page") throw new AiError("noAccess", "Page not found");
  // Its body can't change while it is locked (lib/page-lock); the editor doesn't offer AI then either.
  if (isPageLocked(found)) throw new AiError("noAccess", "The page is locked");
  if (!(await aiAvailable(found.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  return found;
}

/**
 * Starts an editor action and streams the model's answer. The page must be one the person may
 * edit: suggestions end up in it. Selected text is never cut to fit (the result would replace text
 * the model never saw): an oversized selection is refused with "tooLarge".
 */
export async function startEditorAction(userId: string, input: EditorActionInput, signal?: AbortSignal): Promise<AiStream> {
  const { action } = input;
  if (SELECTION_ACTIONS.includes(action) && !input.text?.trim()) throw new AiError("invalid", "Select some text first");
  if (action === "translate" && !isAiLanguage(input.language)) throw new AiError("invalid", "Choose a language to translate into");
  if (action === "custom" && !input.instruction?.trim()) throw new AiError("invalid", "Say what the AI should do");
  const found = await editablePage(userId, input.pageId);
  const maxContent = Math.max(1_000, aiConfig().limits.maxInputChars - PROMPT_OVERHEAD - (input.instruction?.length ?? 0));
  if ((input.text?.length ?? 0) > maxContent) throw new AiError("tooLarge", "The selection is too long for one request");
  // A summary reads the page as it is now on the server, not what the browser sent.
  const page = action === "summarize" ? await getCollab().readPage(input.pageId) : null;
  const prompt = editorPrompt(
    {
      action,
      text: input.text,
      language: input.language,
      instruction: input.instruction,
      before: input.before,
      page: page?.markdown,
      pageTitle: page?.title ?? found.title,
    },
    maxContent,
  );
  if (action === "summarize" && !page?.markdown.trim()) throw new AiError("invalid", "The page is empty");
  return stream({
    feature: `editor.${action}`,
    userId,
    workspaceId: found.workspaceId,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.prompt }],
    signal,
  });
}

/**
 * Saves the page to its history before the person applies a suggestion, so "Before AI assistant
 * edit" in the page history brings back the text as it was.
 */
export async function snapshotBeforeAiEdit(userId: string, pageId: string) {
  await editablePage(userId, pageId);
  await getCollab().snapshot(pageId, "before_ai_edit", { userId });
}

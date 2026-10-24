import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiSavedPrompt } from "@/db/schema";
import { cleanPromptName, cleanPromptText, MAX_SAVED_PROMPTS, savedPromptProblem, type SavedPrompt, type SavedPromptProblem } from "@/lib/ai-saved-prompts";
import { requireMembership } from "@/server/access";

/**
 * Prompts people save to reuse in the editor's AI assistant (lib/ai-saved-prompts): each person's
 * own, in each workspace they belong to. Nobody else reads or changes them.
 */

export class SavedPromptError extends Error {
  constructor(
    readonly code: SavedPromptProblem | "full" | "notFound",
    message: string,
  ) {
    super(message);
    this.name = "SavedPromptError";
  }
}

const columns = { id: aiSavedPrompt.id, name: aiSavedPrompt.name, prompt: aiSavedPrompt.prompt };
const own = (userId: string, id: string) => and(eq(aiSavedPrompt.id, id), eq(aiSavedPrompt.userId, userId));

/** The person's saved prompts in the workspace, oldest first. */
export async function listSavedPrompts(userId: string, workspaceId: string): Promise<SavedPrompt[]> {
  await requireMembership(userId, workspaceId);
  return db
    .select(columns)
    .from(aiSavedPrompt)
    .where(and(eq(aiSavedPrompt.userId, userId), eq(aiSavedPrompt.workspaceId, workspaceId)))
    .orderBy(asc(aiSavedPrompt.createdAt), asc(aiSavedPrompt.id));
}

/** Saves a prompt for the person in the workspace; at most MAX_SAVED_PROMPTS each. */
export async function savePrompt(userId: string, workspaceId: string, input: { name: unknown; prompt: unknown }): Promise<SavedPrompt> {
  await requireMembership(userId, workspaceId);
  const name = cleanPromptName(input.name);
  const prompt = cleanPromptText(input.prompt);
  const problem = savedPromptProblem(name, prompt);
  if (problem) throw new SavedPromptError(problem, `The prompt can't be saved: ${problem}`);
  return db.transaction(async (tx) => {
    // One at a time per person, so two saves at once can't pass the limit together.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_saved_prompt:${userId}:${workspaceId}`}))`);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(aiSavedPrompt)
      .where(and(eq(aiSavedPrompt.userId, userId), eq(aiSavedPrompt.workspaceId, workspaceId)));
    if (n >= MAX_SAVED_PROMPTS) throw new SavedPromptError("full", `At most ${MAX_SAVED_PROMPTS} saved prompts`);
    const [saved] = await tx.insert(aiSavedPrompt).values({ userId, workspaceId, name, prompt }).returning(columns);
    return saved;
  });
}

/** Renames one of the person's saved prompts. */
export async function renameSavedPrompt(userId: string, id: string, input: { name: unknown }): Promise<SavedPrompt> {
  const name = cleanPromptName(input.name);
  const problem = savedPromptProblem(name);
  if (problem) throw new SavedPromptError(problem, `The prompt can't be renamed: ${problem}`);
  const [saved] = await db.update(aiSavedPrompt).set({ name, updatedAt: new Date() }).where(own(userId, id)).returning(columns);
  if (!saved) throw new SavedPromptError("notFound", "No such saved prompt");
  return saved;
}

/** Deletes one of the person's saved prompts. */
export async function deleteSavedPrompt(userId: string, id: string) {
  const deleted = await db.delete(aiSavedPrompt).where(own(userId, id)).returning({ id: aiSavedPrompt.id });
  if (!deleted.length) throw new SavedPromptError("notFound", "No such saved prompt");
}

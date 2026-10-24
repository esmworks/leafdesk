/**
 * Build with AI: someone describes what they need ("a hiring pipeline with candidates, interviews
 * and an offer stage") and the AI drafts a plan of databases (lib/database-plan): typed properties
 * with their options, relations between them, a few views, example rows and an intro page. Nothing
 * is saved by drafting: the person sees the plan, changes what they like, and creating it
 * (server/database-plan createFromPlan) makes it as they left it, as them, in the place they chose.
 *
 * Drafting counts as AI usage ("build.plan") and is held to the workspace's AI limits like any
 * other request; a plan that doesn't pass the check is sent back to the model once, with what is
 * wrong, before the person hears it didn't work.
 */
import { readDraftJson } from "@/lib/agent-draft";
import { MAX_BUILD_REQUEST, validateDatabasePlan, type DatabasePlan } from "@/lib/database-plan";
import { requireMembership } from "@/server/access";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { buildPlanPrompt, buildPlanRepair } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { PlanError } from "@/server/database-plan";

/**
 * A plan of databases for what `request` says, checked (validateDatabasePlan) and not saved. Throws
 * AiError when the workspace has no AI or the request fails, PlanError("unusable") when the AI's
 * plan still doesn't pass after it was told what is wrong.
 */
export async function draftDatabasePlan(
  userId: string,
  workspaceId: string,
  request: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DatabasePlan> {
  await requireMembership(userId, workspaceId);
  const text = typeof request === "string" ? request.trim().slice(0, MAX_BUILD_REQUEST) : "";
  if (!text) throw new AiError("invalid", "Describe what you need");
  if (!(await aiAvailable(workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const prompt = buildPlanPrompt(text);
  const messages: AiMessage[] = [{ role: "user", content: prompt.prompt }];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ feature: "build.plan", userId, workspaceId, system: prompt.system, messages, signal, skipRateLimit: attempt > 0 });
    const checked = result.stopReason === "length" ? null : validateDatabasePlan(readDraftJson(result.text));
    if (checked?.ok) return checked.plan;
    problems = checked ? checked.problems : ["The answer was cut off: make the plan smaller."];
    messages.push(result.message, { role: "user", content: buildPlanRepair(problems) });
  }
  throw new PlanError("unusable", "The AI's plan couldn't be used", problems);
}

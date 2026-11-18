"use server";

import { getLocale, getTranslations } from "next-intl/server";
import type { BuiltinSkillKey } from "@/lib/builtin-skills";
import type { SkillSuggestions } from "@/lib/skill-suggestions";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { requireUserId } from "@/server/session";
import { createSuggestedSkill, suggestSkills } from "@/server/skill-suggestions";
import * as skills from "@/server/skills";
import { TeamspaceError } from "@/server/teamspaces";

export type SkillResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Domain errors become translated messages; anything else is logged and shown as a generic one. */
async function run<T>(label: string, fn: (userId: string) => Promise<T>): Promise<SkillResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (error instanceof skills.SkillError) return { ok: false, error: t(`skills.errors.${error.code}`, { max: skills.MAX_SKILL_DESCRIPTION }) };
    if (error instanceof TeamspaceError) return { ok: false, error: t(`teamspaces.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error(`[${label}]`, error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Marks the page as a skill or not, or changes its description (edit access, see server/skills). */
export async function setSkillAction(pageId: string, change: { skill?: boolean; description?: string }) {
  return run("set skill", (userId) =>
    skills.setSkill(userId, pageId, {
      skill: typeof change.skill === "boolean" ? change.skill : undefined,
      description: typeof change.description === "string" ? change.description : undefined,
    }),
  );
}

/** The skills of the workspace the person can open, for the AI chat's picker. */
export async function listSkillsAction(workspaceId: string) {
  return run("list skills", async (userId) =>
    (await skills.listSkills(userId, workspaceId)).map((s) => ({ id: s.id, title: s.title, icon: s.icon, description: s.description })),
  );
}

/** A new skill, a row of the person's skills database (made when they have none), for the library's New skill button. */
export async function createSkillAction(workspaceId: string) {
  return run("create skill", async (userId) => skills.createSkill(userId, String(workspaceId), {}, await getLocale()));
}

/** Turns a database into a skills database, or back (full access, see server/skills). */
export async function setSkillDatabaseAction(databaseId: string, on: boolean) {
  return run("set skills database", async (userId) => skills.setSkillDatabase(userId, String(databaseId), Boolean(on), await getLocale()));
}

/** A new skill from a built-in one, in the person's language, in their skills database, for the library's gallery. */
export async function createBuiltinSkillAction(workspaceId: string, key: BuiltinSkillKey) {
  return run("create built-in skill", async (userId) => skills.createBuiltinSkill(userId, String(workspaceId), key, await getLocale()));
}

export type SuggestResult = { ok: true; data: SkillSuggestions } | { ok: false; error: string; code?: string };

/**
 * Suggest skills (the library's button, read as `suggestSkills`): the AI proposes skills from the
 * person's recent AI chat questions and edited pages. Creates nothing. `language` is the language
 * the person reads the app in.
 */
export async function suggestSkillsAction(workspaceId: string, language?: string): Promise<SuggestResult> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await suggestSkills(userId, String(workspaceId), language) };
  } catch (error) {
    const t = await getTranslations();
    if (isAiError(error)) return { ok: false, error: t(`ai.errors.${error.code}`, { seconds: error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0 }), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    throw error;
  }
}

/** "Create" on a suggested skill: a row of the person's skills database with what the suggestion showed. */
export async function createSuggestedSkillAction(workspaceId: string, input: { title: string; description: string; instructions: string }) {
  return run("create suggested skill", async (userId) =>
    createSuggestedSkill(
      userId,
      String(workspaceId),
      { title: input?.title, description: input?.description, instructions: input?.instructions },
      await getLocale(),
    ),
  );
}

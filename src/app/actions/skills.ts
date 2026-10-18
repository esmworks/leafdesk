"use server";

import { getLocale, getTranslations } from "next-intl/server";
import type { BuiltinSkillKey } from "@/lib/builtin-skills";
import { AccessError } from "@/server/access";
import * as pages from "@/server/pages";
import { requireUserId } from "@/server/session";
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

/** A new private page, already a skill, for the library's New skill button. */
export async function createSkillAction(workspaceId: string) {
  return run("create skill", async (userId) => {
    const created = await pages.createPage({ userId }, { workspaceId: String(workspaceId), teamspaceId: null });
    await skills.setSkill(userId, created.id, { skill: true });
    return { id: created.id };
  });
}

/** A new private skill from a built-in one, in the person's language, for the library's gallery. */
export async function createBuiltinSkillAction(workspaceId: string, key: BuiltinSkillKey) {
  return run("create built-in skill", async (userId) => skills.createBuiltinSkill(userId, String(workspaceId), key, await getLocale()));
}

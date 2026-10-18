import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import source from "@/i18n/messages/en/skillTemplates.json";

/**
 * The built-in skills: a few ready-made instructions for everyday work that every workspace can
 * start from. They live here and in `i18n/messages/<locale>/skillTemplates.json` (title,
 * description and the Markdown body), not in the database; picking one creates an ordinary private
 * page marked as a skill (see server/skills.ts `createBuiltinSkill`), which its owner can change
 * and share like any other. None of them needs setting up: they work on whatever page, row or
 * text the person points them at.
 */

export const BUILTIN_SKILL_KEYS = [
  "meeting-wrapup",
  "status-summary",
  "customer-reply",
  "proofread",
  "triage-request",
  "executive-summary",
] as const;
export type BuiltinSkillKey = (typeof BUILTIN_SKILL_KEYS)[number];

export const isBuiltinSkillKey = (value: unknown): value is BuiltinSkillKey =>
  typeof value === "string" && (BUILTIN_SKILL_KEYS as readonly string[]).includes(value);

const ICONS: Record<BuiltinSkillKey, string> = {
  "meeting-wrapup": "📝",
  "status-summary": "📊",
  "customer-reply": "✉️",
  proofread: "🔍",
  "triage-request": "🧭",
  "executive-summary": "📌",
};

export type BuiltinSkill = { key: BuiltinSkillKey; icon: string; title: string; description: string; markdown: string };

type Texts = typeof source;

/** The built-in skills in the given UI language; English for any other, and for texts a language lacks. */
export async function builtinSkills(locale: string | undefined): Promise<BuiltinSkill[]> {
  const texts: Texts = !isLocale(locale) || locale === DEFAULT_LOCALE ? source : withFallback(source, await loadLocaleFile(locale, "skillTemplates"));
  return BUILTIN_SKILL_KEYS.map((key) => ({ key, icon: ICONS[key], ...texts[key] }));
}

export async function builtinSkill(key: BuiltinSkillKey, locale: string | undefined): Promise<BuiltinSkill> {
  return (await builtinSkills(locale)).find((s) => s.key === key)!;
}

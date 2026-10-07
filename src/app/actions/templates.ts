"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { builtinTemplates, type BuiltinTemplateKey } from "@/lib/builtin-templates";
import { AccessError, hasLevel } from "@/server/access";
import { requireUserId } from "@/server/session";
import { TeamspaceError } from "@/server/teamspaces";
import * as schedules from "@/server/schedules";
import * as templates from "@/server/templates";

export type TemplateResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Domain errors become translated messages; anything else is logged and shown as a generic one. */
async function run<T>(label: string, fn: (userId: string) => Promise<T>): Promise<TemplateResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    const { code, params } = error as { code?: unknown; params?: Record<string, string> };
    if (error instanceof Error && isDatabaseErrorCode(code)) return { ok: false, error: t(`database.errors.${code}`, params ?? {}) };
    if (error instanceof TeamspaceError) return { ok: false, error: t(`teamspaces.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    if (!(error instanceof PropertyValueError)) console.error(`[${label}]`, error);
    return { ok: false, error: t("common.genericError") };
  }
}

export type TemplatePickerData = {
  templates: { id: string; title: string; icon: string | null; kind: "page" | "database"; canEdit: boolean; canDelete: boolean }[];
  builtins: { key: BuiltinTemplateKey; title: string; description: string; icon: string; kind: "page" | "database" }[];
};

/** The workspace's templates and the built-in gallery (in the user's language), for the picker. */
export async function listTemplatesAction(workspaceId: string) {
  return run("list templates", async (userId): Promise<TemplatePickerData> => {
    const [list, builtins] = await Promise.all([templates.listTemplates(userId, workspaceId), getLocale().then(builtinTemplates)]);
    return {
      templates: list.map((t) => ({
        id: t.id,
        title: t.title,
        icon: t.icon,
        kind: t.kind,
        canEdit: hasLevel(t.level, "edit"),
        canDelete: hasLevel(t.level, "full"),
      })),
      builtins: builtins.map(({ key, title, description, icon, kind }) => ({ key, title, description, icon, kind })),
    };
  });
}

/** `teamspaceId` (top level): a teamspace, null for a private page, undefined for the default teamspace. */
export async function createFromTemplateAction(templateId: string, parentId: string | null = null, teamspaceId?: string | null) {
  return run("new page from template", async (userId) => {
    const created = await templates.createFromTemplate({ userId }, templateId, { parentId, teamspaceId });
    return { id: created.id, workspaceId: created.workspaceId };
  });
}

export async function createFromBuiltinAction(
  workspaceId: string,
  key: BuiltinTemplateKey,
  parentId: string | null = null,
  teamspaceId?: string | null,
) {
  return run("new page from built-in template", async (userId) => {
    const locale = await getLocale();
    return templates.createFromBuiltin({ userId }, workspaceId, key, { locale, parentId, teamspaceId });
  });
}

export async function saveAsTemplateAction(pageId: string) {
  return run("save as template", (userId) => templates.saveAsTemplate({ userId }, pageId));
}

export async function deleteTemplateAction(templateId: string) {
  return run("delete template", (userId) => templates.deleteTemplate(userId, templateId));
}

export async function createRowTemplateAction(databaseId: string) {
  return run("new row template", (userId) => templates.createRowTemplate({ userId }, databaseId));
}

export async function setDefaultRowTemplateAction(databaseId: string, templateId: string | null) {
  return run("default row template", (userId) => templates.setDefaultRowTemplate(userId, databaseId, templateId));
}

/** How a row template repeats, or null when it doesn't. */
export async function getTemplateRepeatAction(templateId: string) {
  return run("read template repeat", (userId) => schedules.getTemplateRepeat(userId, templateId));
}

/** Makes a row template repeat (or changes how), from now on as the user. */
export async function setTemplateRepeatAction(templateId: string, input: schedules.TemplateRepeatInput) {
  return run("set template repeat", (userId) => schedules.setTemplateRepeat(userId, templateId, input));
}

export async function removeTemplateRepeatAction(templateId: string) {
  return run("remove template repeat", (userId) => schedules.removeTemplateRepeat(userId, templateId));
}

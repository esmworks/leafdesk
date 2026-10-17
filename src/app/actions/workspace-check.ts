"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { AccessError } from "@/server/access";
import { linkUnlinkedMention } from "@/server/mentions";
import { archivePage, restorePage } from "@/server/pages";
import { requireUserId } from "@/server/session";
import { removeRelationTarget } from "@/server/workspace-check";
import type { ActionResult } from "./workspaces";

/**
 * What Settings > Health fixes in one click: a page in the trash something links to comes back
 * (`restore`), an empty page goes to the trash (`trash`), an orphan gets linked where another page
 * writes its title (`link`), a relation lets go of a row in the trash or deleted (`unrelate`).
 */
export type CheckFix =
  | { kind: "restore"; pageId: string }
  | { kind: "trash"; pageId: string }
  | { kind: "link"; sourceId: string; targetId: string }
  | { kind: "unrelate"; rowId: string; propertyId: string; targetId: string };

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

/** Applies one fix with the user's own access, each checked again by the call that makes it. */
export async function fixFindingAction(workspaceId: string, fix: CheckFix): Promise<ActionResult> {
  const userId = await requireUserId();
  const t = await getTranslations("settings.health.errors");
  let done: boolean;
  try {
    switch (fix?.kind) {
      case "restore":
        if (!isId(fix.pageId)) return { ok: false, error: t("gone") };
        await restorePage(userId, fix.pageId);
        done = true;
        break;
      case "trash":
        if (!isId(fix.pageId)) return { ok: false, error: t("gone") };
        await archivePage(userId, fix.pageId);
        done = true;
        break;
      case "link":
        if (!isId(fix.sourceId) || !isId(fix.targetId)) return { ok: false, error: t("gone") };
        done = await linkUnlinkedMention(userId, fix.sourceId, fix.targetId);
        break;
      case "unrelate":
        if (!isId(fix.rowId) || !isId(fix.propertyId) || !isId(fix.targetId)) return { ok: false, error: t("gone") };
        done = await removeRelationTarget(userId, fix.rowId, fix.propertyId, fix.targetId);
        break;
      default:
        return { ok: false, error: t("gone") };
    }
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: t("denied") };
    if ((error as { code?: unknown } | null)?.code === "pageLocked") return { ok: false, error: t("locked") };
    throw error;
  }
  if (typeof workspaceId === "string") revalidatePath(`/w/${workspaceId}`, "layout");
  return done ? { ok: true, data: undefined } : { ok: false, error: t("gone") };
}

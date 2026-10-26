"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames, icalNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { IcalSyncView } from "@/lib/ical-sync";
import type { ImportResult } from "@/lib/import/result";
import { AccessError } from "@/server/access";
import { createIcalSync, getIcalSync, stopIcalSync, syncIcalNow, updateIcalSync, type IcalSyncPatch } from "@/server/ical-sync/manage";
import { JiraError } from "@/server/jira-sync/client";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

// Calendar syncs (see server/ical-sync): set up from the import dialog, looked after from the
// database's sync dialog. Expected failures come back translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    // A calendar's errors are JiraErrors with the codes every sync shares (server/ical-sync/run).
    if (error instanceof JiraError && error.code !== "badQuery") {
      const t = await getTranslations("import.ical.errors");
      return { ok: false, error: t(error.code), code: error.code };
    }
    if (error instanceof SyncSetupLimited) {
      const t = await getTranslations("import.errors");
      return { ok: false, error: t("rateLimited") };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) {
      const t = await getTranslations("database.errors");
      return { ok: false, error: t("accessDenied") };
    }
    console.error("[calendar sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

export type IcalSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  url: string;
  intervalMinutes: unknown;
};

/** Makes a database from a calendar's events and keeps it in step (answered like an import). */
export async function createIcalSyncAction(value: IcalSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createIcalSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        url: value?.url,
        intervalMinutes: value?.intervalMinutes,
        names: await icalNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getIcalSyncAction(databaseId: string): Promise<ActionResult<IcalSyncView | null>> {
  return run((userId) => getIcalSync(userId, String(databaseId)));
}

export async function syncIcalNowAction(databaseId: string): Promise<ActionResult<IcalSyncView>> {
  return run((userId) => syncIcalNow(userId, String(databaseId)));
}

export async function updateIcalSyncAction(databaseId: string, patch: IcalSyncPatch): Promise<ActionResult<IcalSyncView>> {
  return run((userId) => updateIcalSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, url: patch?.url }));
}

export async function stopIcalSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopIcalSync(userId, String(databaseId));
    return undefined;
  });
}

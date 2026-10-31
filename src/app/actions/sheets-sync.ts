"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ImportResult } from "@/lib/import/result";
import type { SheetsSource, SheetsSyncView } from "@/lib/sheets-sync";
import { AccessError } from "@/server/access";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncOutcome } from "@/server/jira-sync/run";
import {
  createSheetsSync,
  getSheetsSync,
  SheetsSetupError,
  sheetsSources,
  stopSheetsSync,
  syncSheetsByPlace,
  syncSheetsNow,
  updateSheetsSync,
  type SheetsSyncPatch,
} from "@/server/sheets-sync/manage";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

// Google Sheets syncs (see server/sheets-sync): set up from the import dialog, looked after from
// the database's sync dialog. Expected failures come back translated, with Google's own words for
// a refused read: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof JiraError) {
      const t = await getTranslations("import.sheets.errors");
      const message = t(error.code);
      return { ok: false, error: error.code === "badQuery" && error.detail ? `${message} ${error.detail}` : message, code: error.code };
    }
    if (error instanceof SheetsSetupError) {
      const t = await getTranslations("import.sheets.errors");
      return { ok: false, error: t(error.code) };
    }
    if (error instanceof SyncSetupLimited) {
      const t = await getTranslations("import.errors");
      return { ok: false, error: t("rateLimited") };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) {
      const t = await getTranslations("database.errors");
      return { ok: false, error: t("accessDenied") };
    }
    console.error("[sheets sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

/** The name of a sync by place's row number property, in the person's language. */
const rowName = async () => (await getTranslations("database.sheetsSync"))("rowProperty");

/** The Google Sheets connections the person may sync through. */
export async function sheetsSourcesAction(workspaceId: string): Promise<ActionResult<SheetsSource[]>> {
  return run((userId) => sheetsSources(userId, String(workspaceId ?? "")));
}

export type SheetsSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  connectionId: string;
  link: string;
  headerRow?: number | null;
  keyColumn?: string;
  titleColumn?: string;
  intervalMinutes: unknown;
  direction?: unknown;
};

/** Makes a database from a sheet's rows and keeps it in step (answered like an import). */
export async function createSheetsSyncAction(value: SheetsSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createSheetsSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        connectionId: value?.connectionId,
        link: value?.link,
        headerRow: typeof value?.headerRow === "number" ? value.headerRow : undefined,
        keyColumn: typeof value?.keyColumn === "string" ? value.keyColumn : undefined,
        titleColumn: typeof value?.titleColumn === "string" ? value.titleColumn : undefined,
        intervalMinutes: value?.intervalMinutes,
        direction: value?.direction,
        rowName: await rowName(),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getSheetsSyncAction(databaseId: string): Promise<ActionResult<SheetsSyncView | null>> {
  return run((userId) => getSheetsSync(userId, String(databaseId)));
}

export async function syncSheetsNowAction(databaseId: string): Promise<ActionResult<SheetsSyncView & { outcome: SyncOutcome }>> {
  return run((userId) => syncSheetsNow(userId, String(databaseId)));
}

export async function updateSheetsSyncAction(databaseId: string, patch: SheetsSyncPatch): Promise<ActionResult<SheetsSyncView>> {
  return run((userId) =>
    updateSheetsSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, connectionId: patch?.connectionId, direction: patch?.direction }),
  );
}

/** Finds the sync's rows by their place in the sheet from now on: its rows come back from the sheet. */
export async function syncSheetsByPlaceAction(databaseId: string): Promise<ActionResult<SheetsSyncView & { outcome: SyncOutcome }>> {
  return run(async (userId) => syncSheetsByPlace(userId, String(databaseId), await rowName()));
}

export async function stopSheetsSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopSheetsSync(userId, String(databaseId));
    return undefined;
  });
}

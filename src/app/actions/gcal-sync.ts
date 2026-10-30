"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames, icalNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { GcalCalendar, GcalSource, GcalSyncView } from "@/lib/gcal-sync";
import type { ImportResult } from "@/lib/import/result";
import { AccessError } from "@/server/access";
import { createGcalSync, gcalCalendars, gcalSources, getGcalSync, stopGcalSync, syncGcalNow, updateGcalSync, type GcalSyncPatch } from "@/server/gcal-sync/manage";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncOutcome } from "@/server/jira-sync/run";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

// Google Calendar syncs (see server/gcal-sync): set up from the import dialog, looked after from
// the database's sync dialog. Expected failures come back translated, with Google's own words for
// a refused read or write: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof JiraError) {
      const t = await getTranslations("import.gcal.errors");
      const message = t(error.code);
      return { ok: false, error: error.code === "badQuery" && error.detail ? `${message} ${error.detail}` : message, code: error.code };
    }
    if (error instanceof SyncSetupLimited) {
      const t = await getTranslations("import.errors");
      return { ok: false, error: t("rateLimited") };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) {
      const t = await getTranslations("database.errors");
      return { ok: false, error: t("accessDenied") };
    }
    console.error("[google calendar sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

/** The Google Calendar connections the person may sync through. */
export async function gcalSourcesAction(workspaceId: string): Promise<ActionResult<GcalSource[]>> {
  return run((userId) => gcalSources(userId, String(workspaceId ?? "")));
}

/** The calendars in a connection's account's list (the main calendar aside). */
export async function gcalCalendarsAction(workspaceId: string, connectionId: string): Promise<ActionResult<GcalCalendar[]>> {
  return run((userId) => gcalCalendars(userId, String(workspaceId ?? ""), connectionId));
}

export type GcalSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  connectionId: string;
  calendarId: string;
  intervalMinutes: unknown;
  direction?: unknown;
};

/** Makes a database from a calendar's events and keeps it in step (answered like an import). */
export async function createGcalSyncAction(value: GcalSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createGcalSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        connectionId: value?.connectionId,
        calendarId: value?.calendarId,
        intervalMinutes: value?.intervalMinutes,
        direction: value?.direction,
        names: await icalNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getGcalSyncAction(databaseId: string): Promise<ActionResult<GcalSyncView | null>> {
  return run((userId) => getGcalSync(userId, String(databaseId)));
}

export async function syncGcalNowAction(databaseId: string): Promise<ActionResult<GcalSyncView & { outcome: SyncOutcome }>> {
  return run((userId) => syncGcalNow(userId, String(databaseId)));
}

export async function updateGcalSyncAction(databaseId: string, patch: GcalSyncPatch): Promise<ActionResult<GcalSyncView>> {
  return run((userId) =>
    updateGcalSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, connectionId: patch?.connectionId, direction: patch?.direction }),
  );
}

export async function stopGcalSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopGcalSync(userId, String(databaseId));
    return undefined;
  });
}

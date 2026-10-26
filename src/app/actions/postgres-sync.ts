"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ImportResult } from "@/lib/import/result";
import type { PostgresSyncView } from "@/lib/postgres-sync";
import { AccessError } from "@/server/access";
import { JiraError } from "@/server/jira-sync/client";
import {
  createPostgresSync,
  getPostgresSync,
  stopPostgresSync,
  syncPostgresNow,
  updatePostgresSync,
  type PostgresSyncPatch,
} from "@/server/postgres-sync/manage";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

// PostgreSQL table syncs (see server/postgres-sync): set up from the import dialog, looked after
// from the database's sync dialog. Expected failures come back translated, with the server's own
// words for a refused query: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof JiraError) {
      const t = await getTranslations("import.postgres.errors");
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
    console.error("[postgres sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

export type PostgresSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  url: string;
  table: string;
  keyColumn?: string;
  titleColumn?: string;
  intervalMinutes: unknown;
};

/** Makes a database from a table's rows and keeps it in step (answered like an import). */
export async function createPostgresSyncAction(value: PostgresSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createPostgresSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        url: value?.url,
        table: value?.table,
        keyColumn: typeof value?.keyColumn === "string" ? value.keyColumn : undefined,
        titleColumn: typeof value?.titleColumn === "string" ? value.titleColumn : undefined,
        intervalMinutes: value?.intervalMinutes,
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getPostgresSyncAction(databaseId: string): Promise<ActionResult<PostgresSyncView | null>> {
  return run((userId) => getPostgresSync(userId, String(databaseId)));
}

export async function syncPostgresNowAction(databaseId: string): Promise<ActionResult<PostgresSyncView>> {
  return run((userId) => syncPostgresNow(userId, String(databaseId)));
}

export async function updatePostgresSyncAction(databaseId: string, patch: PostgresSyncPatch): Promise<ActionResult<PostgresSyncView>> {
  return run((userId) => updatePostgresSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, url: patch?.url }));
}

export async function stopPostgresSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopPostgresSync(userId, String(databaseId));
    return undefined;
  });
}

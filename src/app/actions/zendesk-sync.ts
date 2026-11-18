"use server";

import { revalidatePath } from "next/cache";
import { crmRun } from "@/app/actions/crm-run";
import { databaseSeedNames, zendeskNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ImportResult } from "@/lib/import/result";
import type { CrmSyncView } from "@/lib/crm-sync";
import { createZendeskSync, getZendeskSync, stopZendeskSync, syncZendeskNow, updateZendeskSync } from "@/server/zendesk-sync/manage";

// Zendesk ticket syncs (see server/zendesk-sync): set up from the import dialog, looked after from
// the database's sync dialog.

const run = <T>(fn: (userId: string) => Promise<T>) => crmRun("zendesk", fn);

export type ZendeskSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  site: string;
  email: string;
  token: string;
  intervalMinutes: unknown;
};

/** Makes a database from a Zendesk account's tickets and keeps it in step (answered like an import). */
export async function createZendeskSyncAction(value: ZendeskSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createZendeskSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        site: value?.site,
        email: value?.email,
        token: value?.token,
        intervalMinutes: value?.intervalMinutes,
        names: await zendeskNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getZendeskSyncAction(databaseId: string): Promise<ActionResult<CrmSyncView | null>> {
  return run((userId) => getZendeskSync(userId, String(databaseId)));
}

export async function syncZendeskNowAction(databaseId: string): Promise<ActionResult<CrmSyncView>> {
  return run((userId) => syncZendeskNow(userId, String(databaseId)));
}

export async function updateZendeskSyncAction(
  databaseId: string,
  patch: { intervalMinutes?: unknown; email?: unknown; token?: unknown },
): Promise<ActionResult<CrmSyncView>> {
  return run((userId) => updateZendeskSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, email: patch?.email, token: patch?.token }));
}

export async function stopZendeskSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopZendeskSync(userId, String(databaseId));
    return undefined;
  });
}

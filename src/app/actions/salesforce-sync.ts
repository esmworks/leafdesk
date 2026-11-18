"use server";

import { revalidatePath } from "next/cache";
import { crmRun } from "@/app/actions/crm-run";
import { databaseSeedNames, salesforceNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ImportResult } from "@/lib/import/result";
import type { CrmSyncView } from "@/lib/crm-sync";
import {
  createSalesforceSync,
  getSalesforceSync,
  stopSalesforceSync,
  syncSalesforceNow,
  updateSalesforceSync,
} from "@/server/salesforce-sync/manage";

// Salesforce syncs (see server/salesforce-sync): set up from the import dialog, looked after from
// the database's sync dialog.

const run = <T>(fn: (userId: string) => Promise<T>) => crmRun("salesforce", fn);

export type SalesforceSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  site: string;
  clientId: string;
  clientSecret: string;
  object: string;
  intervalMinutes: unknown;
};

/** Makes a database from one object of a Salesforce org and keeps it in step (answered like an import). */
export async function createSalesforceSyncAction(value: SalesforceSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createSalesforceSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        site: value?.site,
        clientId: value?.clientId,
        clientSecret: value?.clientSecret,
        object: value?.object,
        intervalMinutes: value?.intervalMinutes,
        names: await salesforceNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getSalesforceSyncAction(databaseId: string): Promise<ActionResult<CrmSyncView | null>> {
  return run((userId) => getSalesforceSync(userId, String(databaseId)));
}

export async function syncSalesforceNowAction(databaseId: string): Promise<ActionResult<CrmSyncView>> {
  return run((userId) => syncSalesforceNow(userId, String(databaseId)));
}

export async function updateSalesforceSyncAction(
  databaseId: string,
  patch: { intervalMinutes?: unknown; clientId?: unknown; clientSecret?: unknown },
): Promise<ActionResult<CrmSyncView>> {
  return run((userId) =>
    updateSalesforceSync(userId, String(databaseId), { intervalMinutes: patch?.intervalMinutes, clientId: patch?.clientId, clientSecret: patch?.clientSecret }),
  );
}

export async function stopSalesforceSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopSalesforceSync(userId, String(databaseId));
    return undefined;
  });
}

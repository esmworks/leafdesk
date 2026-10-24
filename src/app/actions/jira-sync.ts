"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames, jiraSyncNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { ImportResult } from "@/lib/import/result";
import { MAX_JIRA_ISSUES, type JiraProject, type JiraSyncView } from "@/lib/jira-sync";
import { AccessError } from "@/server/access";
import { JiraError } from "@/server/jira-sync/client";
import {
  checkJira,
  createJiraSync,
  getJiraSync,
  jiraProjectsOf,
  stopJiraSync,
  syncJiraNow,
  updateJiraSync,
  type JiraCredentials,
  type JiraSyncPatch,
} from "@/server/jira-sync/manage";
import { requireUserId } from "@/server/session";
import { TeamspaceError } from "@/server/teamspaces";

// Jira syncs (see server/jira-sync): set up from the import dialog, looked after from the
// database's sync dialog. Expected failures come back translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof JiraError) {
      const t = await getTranslations("import.jira.errors");
      const text =
        error.code === "badQuery" && error.detail
          ? t("badQueryDetail", { detail: error.detail })
          : t(error.code, { limit: MAX_JIRA_ISSUES });
      return { ok: false, error: text, code: error.code };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) {
      const t = await getTranslations("database.errors");
      return { ok: false, error: t("accessDenied") };
    }
    console.error("[jira sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

const credentials = (value: JiraCredentials): JiraCredentials => ({ siteUrl: value?.siteUrl, email: value?.email, token: value?.token });

/** Signs in to a Jira site to check what was typed: whose account it is, and the projects it sees. */
export async function checkJiraAction(value: JiraCredentials): Promise<ActionResult<{ account: string; projects: JiraProject[] }>> {
  return run(() => checkJira(credentials(value)));
}

export type JiraSyncSetup = JiraCredentials & {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  query: unknown;
  intervalMinutes: unknown;
};

/** Makes a database from a Jira query and keeps it in step (answered like an import). */
export async function createJiraSyncAction(value: JiraSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createJiraSync(
      { userId },
      {
        ...credentials(value),
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        query: value?.query,
        intervalMinutes: value?.intervalMinutes,
        names: await jiraSyncNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getJiraSyncAction(databaseId: string): Promise<ActionResult<JiraSyncView | null>> {
  return run((userId) => getJiraSync(userId, String(databaseId)));
}

export async function syncJiraNowAction(databaseId: string): Promise<ActionResult<JiraSyncView>> {
  return run((userId) => syncJiraNow(userId, String(databaseId)));
}

export async function updateJiraSyncAction(databaseId: string, patch: JiraSyncPatch): Promise<ActionResult<JiraSyncView>> {
  return run((userId) =>
    updateJiraSync(userId, String(databaseId), {
      query: patch?.query,
      intervalMinutes: patch?.intervalMinutes,
      email: patch?.email,
      token: patch?.token,
    }),
  );
}

export async function jiraProjectsAction(databaseId: string): Promise<ActionResult<JiraProject[]>> {
  return run((userId) => jiraProjectsOf(userId, String(databaseId)));
}

export async function stopJiraSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopJiraSync(userId, String(databaseId));
    return undefined;
  });
}

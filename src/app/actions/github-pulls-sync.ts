"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { databaseSeedNames, githubPullsNames } from "@/app/actions/seed-names";
import type { ActionResult } from "@/app/actions/workspaces";
import type { GithubPullsSyncView } from "@/lib/github-pulls-sync";
import type { ImportResult } from "@/lib/import/result";
import { AccessError } from "@/server/access";
import {
  createGithubPullsSync,
  getGithubPullsSync,
  stopGithubPullsSync,
  syncGithubPullsNow,
  updateGithubPullsSync,
  type GithubPullsSyncPatch,
} from "@/server/github-pulls/manage";
import { JiraError } from "@/server/jira-sync/client";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

// GitHub pull request syncs (see server/github-pulls): set up from the import dialog, looked after
// from the database's sync dialog. Expected failures come back translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    // GitHub's errors are JiraErrors with the codes both share (server/github-pulls/client).
    if (error instanceof JiraError && error.code !== "badQuery" && error.code !== "tooManyIssues") {
      const t = await getTranslations("import.githubPulls.errors");
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
    console.error("[github sync action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

export type GithubPullsSyncSetup = {
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  title?: string;
  apiUrl?: string;
  repo: string;
  state: string;
  token?: string;
  intervalMinutes: unknown;
};

/** Makes a database from a repository's pull requests and keeps it in step (answered like an import). */
export async function createGithubPullsSyncAction(value: GithubPullsSyncSetup): Promise<ActionResult<ImportResult>> {
  return run(async (userId) => {
    const space = value?.teamspaceId;
    const result = await createGithubPullsSync(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        title: typeof value?.title === "string" ? value.title : undefined,
        apiUrl: value?.apiUrl,
        query: { repo: value?.repo, state: value?.state },
        token: value?.token,
        intervalMinutes: value?.intervalMinutes,
        names: await githubPullsNames().catch(() => undefined),
        seedNames: await databaseSeedNames().catch(() => undefined),
      },
    );
    revalidatePath(`/w/${value.workspaceId}`, "layout");
    return result;
  });
}

export async function getGithubPullsSyncAction(databaseId: string): Promise<ActionResult<GithubPullsSyncView | null>> {
  return run((userId) => getGithubPullsSync(userId, String(databaseId)));
}

export async function syncGithubPullsNowAction(databaseId: string): Promise<ActionResult<GithubPullsSyncView>> {
  return run((userId) => syncGithubPullsNow(userId, String(databaseId)));
}

export async function updateGithubPullsSyncAction(databaseId: string, patch: GithubPullsSyncPatch): Promise<ActionResult<GithubPullsSyncView>> {
  return run((userId) =>
    updateGithubPullsSync(userId, String(databaseId), { state: patch?.state, intervalMinutes: patch?.intervalMinutes, token: patch?.token }),
  );
}

export async function stopGithubPullsSyncAction(databaseId: string): Promise<ActionResult> {
  return run(async (userId) => {
    await stopGithubPullsSync(userId, String(databaseId));
    return undefined;
  });
}

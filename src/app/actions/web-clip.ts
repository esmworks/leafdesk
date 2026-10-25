"use server";

import { getLocale, getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { env } from "@/lib/env";
import { AccessError } from "@/server/access";
import { getTree, type TreeNode } from "@/server/pages";
import { requireUserId } from "@/server/session";
import { TeamspaceError } from "@/server/teamspaces";
import { lastWebClipTarget, saveWebPage, WebClipError, type SavedWebPage } from "@/server/web-clip";
import { topLevelAccess } from "@/server/workspaces";

// Saving a web page (server/web-clip.ts) from the import dialog and the share page. Expected
// failures come back translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("import");
    if (error instanceof WebClipError) return { ok: false, error: t(`web.errors.${error.code}`), code: error.code };
    if (error instanceof AccessError || error instanceof TeamspaceError) return { ok: false, error: t("errors.noAccess"), code: "noAccess" };
    // Guards of the page written to (a parent in the trash, a locked page), as the import route answers them.
    if (error instanceof Error && error.constructor === Error) return { ok: false, error: t("errors.badRequest"), code: "badRequest" };
    console.error("[web clip]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

export type WebClipSetup = {
  /** Where the person saved a web page to the last time (still theirs to edit), or null: a private page at the top. */
  last: string | null;
  /** Whether they may add pages at the top of the workspace. */
  topLevel: boolean;
  /** The app's address, for the bookmarklet. */
  appUrl: string;
};

/** What the save form starts with in a workspace. */
export async function webClipSetupAction(workspaceId: string): Promise<ActionResult<WebClipSetup>> {
  return run(async (userId) => {
    const id = String(workspaceId ?? "");
    const [last, topLevel] = await Promise.all([lastWebClipTarget(userId, id), topLevelAccess(userId, id)]);
    return { last, topLevel: topLevel !== null, appUrl: env.appUrl };
  });
}

/** The share page's targets in another workspace: its tree and the setup. */
export async function webClipTargetsAction(workspaceId: string): Promise<ActionResult<WebClipSetup & { tree: TreeNode[] }>> {
  return run(async (userId) => {
    const id = String(workspaceId ?? "");
    const [last, topLevel, tree] = await Promise.all([lastWebClipTarget(userId, id), topLevelAccess(userId, id), getTree(userId, id)]);
    return { last, topLevel: topLevel !== null, appUrl: env.appUrl, tree };
  });
}

/** Saves the web page at `url` into the workspace, under `targetId` (a page or a database) or at the top as a private page. */
export async function saveWebPageAction(value: {
  workspaceId: string;
  url: string;
  targetId: string | null;
  quote?: string;
}): Promise<ActionResult<SavedWebPage>> {
  return run(async (userId) =>
    saveWebPage(
      { userId },
      {
        workspaceId: String(value?.workspaceId ?? ""),
        url: typeof value?.url === "string" ? value.url : "",
        targetId: typeof value?.targetId === "string" && value.targetId ? value.targetId : null,
        quote: typeof value?.quote === "string" ? value.quote : undefined,
        remember: true,
        locale: await getLocale(),
      },
    ),
  );
}

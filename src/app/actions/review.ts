"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { PendingChangeFilter, PendingChangeView } from "@/lib/pending-changes";
import { AccessError, sessionHeldBack } from "@/server/access";
import * as review from "@/server/pending-changes";
import { requireUserId } from "@/server/session";

// The "For review" queue (server/pending-changes.ts) for the app: its page, the row banner and the
// sidebar's count. Expected failures come back translated, with their code for the caller.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("review.errors");
    if (error instanceof review.PendingChangeError) {
      // An edit's own message says what is wrong with it (in English, like the server's value checks).
      return { ok: false, error: error.code === "invalid" ? t("invalid", { message: error.message }) : t(error.code), code: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    console.error("[review action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

const filterOf = (filter: PendingChangeFilter | undefined): PendingChangeFilter => ({
  agentId: typeof filter?.agentId === "string" && filter.agentId ? filter.agentId : null,
  databaseId: typeof filter?.databaseId === "string" && filter.databaseId ? filter.databaseId : null,
  rowId: typeof filter?.rowId === "string" && filter.rowId ? filter.rowId : null,
});

export type ReviewQueue = {
  changes: PendingChangeView[];
  facets: Awaited<ReturnType<typeof review.pendingFacets>>;
};

/** The queue as its page shows it: the changes matching `filter`, and what can be filtered by. */
export async function listPendingChangesAction(
  workspaceId: string,
  filter?: PendingChangeFilter,
  status: "open" | "decided" = "open",
): Promise<ActionResult<ReviewQueue>> {
  return run(async (userId) => {
    const [changes, facets] = await Promise.all([
      review.listPendingChanges(userId, String(workspaceId), { filter: filterOf(filter), status: status === "decided" ? "decided" : "open" }),
      review.pendingFacets(userId, String(workspaceId)),
    ]);
    return { changes, facets };
  });
}

/** The changes waiting on one row, for its banner. */
export async function rowPendingChangesAction(workspaceId: string, rowId: string): Promise<ActionResult<PendingChangeView[]>> {
  return run((userId) => review.listPendingChanges(userId, String(workspaceId), { filter: { rowId: String(rowId) } }));
}

/** How many changes wait for the person in the workspace, for the sidebar. */
export async function pendingCountAction(workspaceId: string): Promise<number> {
  const userId = await requireUserId();
  // The count is SQL only: none where a policy of the workspace holds the session back.
  if (await sessionHeldBack(userId, String(workspaceId)).catch(() => true)) return 0;
  return review.countPendingFor(userId, String(workspaceId)).catch(() => 0);
}

/** Saves a reviewer's edit of a change, to approve later. */
export async function editPendingChangeAction(changeId: string, edit: unknown): Promise<ActionResult<PendingChangeView>> {
  return run((userId) => review.editPendingChange(userId, String(changeId), edit));
}

/** Approves a change (with an edit, when given); `force` overwrites a row that changed since. */
export async function approvePendingChangeAction(
  changeId: string,
  options: { edit?: unknown; force?: boolean } = {},
): Promise<ActionResult<PendingChangeView>> {
  return run((userId) =>
    review.approvePendingChange(userId, String(changeId), {
      payload: options.edit === undefined ? undefined : options.edit,
      force: options.force === true,
      actor: { userId },
    }),
  );
}

export async function dismissPendingChangeAction(changeId: string): Promise<ActionResult<PendingChangeView>> {
  return run((userId) => review.dismissPendingChange(userId, String(changeId)));
}

/** Approves or dismisses several changes, each on its own: what can't be is reported with why. */
export async function decidePendingChangesAction(ids: string[], decision: "approve" | "dismiss", force = false) {
  return run((userId) =>
    review.decidePendingChanges(
      userId,
      (Array.isArray(ids) ? ids : []).map(String),
      decision === "approve" ? "approve" : "dismiss",
      { force: force === true, actor: { userId } },
    ),
  );
}

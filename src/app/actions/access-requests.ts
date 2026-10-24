"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SharingErrorCode, SharingResult } from "@/app/actions/sharing";
import { isApprovalLevel, isMoreAccessLevel } from "@/lib/access-requests";
import { AccessError } from "@/server/access";
import {
  AccessRequestError,
  approveAccessRequest,
  declineAccessRequest,
  requestMoreAccess,
  requestPageAccess,
  type AccessRequestOutcome,
  type MoreAccessOutcome,
} from "@/server/access-requests";
import { getCollab } from "@/server/collab/bridge";
import { PermissionError } from "@/server/permissions";
import { requireUserId } from "@/server/session";

/** From the "You don't have access" screen: the same answer whether or not the page exists. */
export async function requestAccessAction(pageId: string, message: string): Promise<AccessRequestOutcome> {
  const userId = await requireUserId();
  if (typeof pageId !== "string" || !pageId) return "sent";
  return requestPageAccess(userId, pageId, message, (work) =>
    after(() =>
      work().catch((error) => {
        console.error("[access request]", error);
      }),
    ),
  );
}

/**
 * From the Share menu of a page the user can open: asks for comment or edit access. "denied" when
 * they can't open it (any more).
 */
export async function requestMoreAccessAction(pageId: string, level: string, message: string): Promise<MoreAccessOutcome | "denied"> {
  const userId = await requireUserId();
  if (typeof pageId !== "string" || !pageId || !isMoreAccessLevel(level)) return "unavailable";
  try {
    return await requestMoreAccess(userId, pageId, level, message);
  } catch (error) {
    if (error instanceof AccessError) return "denied";
    throw error;
  }
}

async function answer(run: (userId: string) => Promise<{ workspaceId: string }>): Promise<SharingResult> {
  const userId = await requireUserId();
  let workspaceId: string;
  try {
    ({ workspaceId } = await run(userId));
  } catch (error) {
    if (error instanceof PermissionError) return { ok: false, code: error.code satisfies SharingErrorCode };
    if (error instanceof AccessError) return { ok: false, code: "accessDenied" };
    // A level they already have: the panel is behind, it reloads.
    if (error instanceof AccessRequestError) return { ok: false, code: "generic" };
    console.error("[access request action]", error);
    return { ok: false, code: "generic" };
  }
  // Sidebars refetch the tree: the requester may see the page now.
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  revalidatePath(`/w/${workspaceId}`, "layout");
  return { ok: true };
}

/** Shares the page with the requester at `level`, bringing them in as a guest when they are outside. */
export async function approveAccessRequestAction(requestId: string, level: string): Promise<SharingResult> {
  if (!isApprovalLevel(level)) return { ok: false, code: "generic" };
  return answer((userId) => approveAccessRequest(userId, requestId, level));
}

export async function declineAccessRequestAction(requestId: string): Promise<SharingResult> {
  return answer((userId) => declineAccessRequest(userId, requestId));
}

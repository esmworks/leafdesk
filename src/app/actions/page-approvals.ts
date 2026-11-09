"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import type { ApprovalRound } from "@/lib/page-approvals";
import { AccessError } from "@/server/access";
import { approvalCandidates, approvalHistory, ApprovalError, decideApproval, requestApproval, withdrawApproval, type ApprovalCandidate } from "@/server/page-approvals";
import { requireUserId } from "@/server/session";

export type ApprovalResult = { ok: true } | { ok: false; error: string };

async function refused(error: unknown, where: string): Promise<{ ok: false; error: string }> {
  const t = await getTranslations();
  if (error instanceof ApprovalError) return { ok: false, error: t(`page.approval.errors.${error.code}`) };
  if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
  console.error(`[${where}]`, error);
  return { ok: false, error: t("common.genericError") };
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Asks people to approve the page as it is now (server/page-approvals: edit access, approvers who
 * can open it). `input` is narrowed here and checked in full there.
 */
export async function requestApprovalAction(
  workspaceId: string,
  pageId: string,
  input: { approverIds: string[]; rule: string; dueDate: string | null; note: string | null },
): Promise<ApprovalResult> {
  const userId = await requireUserId();
  const raw = input && typeof input === "object" ? input : ({} as Record<string, unknown>);
  try {
    await requestApproval(userId, String(pageId), {
      approverIds: Array.isArray(raw.approverIds) ? raw.approverIds.slice(0, 100) : raw.approverIds,
      rule: text(raw.rule),
      dueDate: text(raw.dueDate),
      note: typeof raw.note === "string" ? raw.note.slice(0, 5000) : null,
    });
    revalidatePath(`/w/${workspaceId}/p/${pageId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, "request approval");
  }
}

/** Approves a round, or asks for changes with a comment (server/page-approvals). */
export async function decideApprovalAction(workspaceId: string, approvalId: string, decision: string, comment: string | null): Promise<ApprovalResult> {
  const userId = await requireUserId();
  try {
    const { pageId } = await decideApproval(userId, String(approvalId), text(decision), typeof comment === "string" ? comment.slice(0, 5000) : null);
    revalidatePath(`/w/${workspaceId}/p/${pageId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, "decide approval");
  }
}

/** Withdraws an open round: its requester or someone with full access. */
export async function withdrawApprovalAction(workspaceId: string, approvalId: string): Promise<ApprovalResult> {
  const userId = await requireUserId();
  try {
    const { pageId } = await withdrawApproval(userId, String(approvalId));
    revalidatePath(`/w/${workspaceId}/p/${pageId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, "withdraw approval");
  }
}

/** Who may be asked to approve the page (a read: the request dialog asks as it opens). */
export async function approvalCandidatesAction(pageId: string): Promise<ApprovalCandidate[]> {
  const userId = await requireUserId();
  return approvalCandidates(userId, String(pageId));
}

/** The page's approval rounds, newest first (a read: the badge's popover asks as it opens). */
export async function approvalHistoryAction(pageId: string): Promise<ApprovalRound[]> {
  const userId = await requireUserId();
  return approvalHistory(userId, String(pageId));
}

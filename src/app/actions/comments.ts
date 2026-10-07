"use server";

import { getTranslations } from "next-intl/server";
import { CommentError, type CommentOp } from "@/lib/comments";
import { AccessError } from "@/server/access";
import * as comments from "@/server/comments";
import { requireUserId } from "@/server/session";

export type CommentFailure = "notAllowed" | "notFound" | "invalidBody" | "tooLong";

/**
 * One comment change from the editor. Failures the person can act on come back as a code (errors
 * thrown by actions lose their message in production); the change itself reaches every open editor
 * through the page's document.
 */
export async function changeCommentsAction(pageId: string, op: CommentOp) {
  const userId = await requireUserId();
  try {
    return { ok: true as const, ...(await comments.changeComments(userId, pageId, op)) };
  } catch (error) {
    if (error instanceof CommentError) return { ok: false as const, code: error.code as CommentFailure };
    if (error instanceof AccessError) return { ok: false as const, code: "notAllowed" as CommentFailure };
    throw error;
  }
}

/** Who wrote, reacted to or resolved comments; an agent's name says it is one. */
export async function commentUsersAction(pageId: string, userIds: string[]) {
  const userId = await requireUserId();
  const users = await comments.commentUsers(userId, pageId, userIds);
  if (!users.some((u) => u.isAgent)) return users;
  const t = await getTranslations("common");
  return users.map((u) => (u.isAgent ? { ...u, username: t("agentName", { name: u.username }) } : u));
}

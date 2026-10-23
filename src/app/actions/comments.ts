"use server";

import { getTranslations } from "next-intl/server";
import { CommentError, type CommentOp } from "@/lib/comments";
import { LegalHoldError } from "@/lib/legal-hold";
import { AccessError } from "@/server/access";
import * as comments from "@/server/comments";
import { requireUserId } from "@/server/session";
import { mutedThreads, setThreadMuted } from "@/server/thread-mute";

export type CommentFailure = "notAllowed" | "notFound" | "invalidBody" | "tooLong" | "commentHeld";

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
    // Said to the person: the comment stays where they tried to delete it.
    if (error instanceof LegalHoldError) {
      const message = (await getTranslations("settings.legalHolds.errors"))("commentHeld");
      return { ok: false as const, code: "commentHeld" as CommentFailure, message };
    }
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

/** The page's threads whose replies the viewer muted. */
export async function mutedThreadsAction(pageId: string) {
  const userId = await requireUserId();
  return mutedThreads(userId, pageId);
}

/** Mutes the replies in a thread of the page, or hears about them again. */
export async function muteThreadAction(pageId: string, threadId: string, muted: boolean) {
  const userId = await requireUserId();
  return setThreadMuted(userId, pageId, threadId, muted);
}

"use server";

import { getTranslations } from "next-intl/server";
import { CommentError, type CommentOp } from "@/lib/comments";
import { AccessError } from "@/server/access";
import type { Decision } from "@/lib/suggestions";
import * as comments from "@/server/comments";
import { requireUserId } from "@/server/session";
import { answerSuggestions } from "@/server/suggested-edits";
import { mutedThreads, setThreadMuted } from "@/server/thread-mute";
import { markThreadsSeen, setThreadMarked, threadStates } from "@/server/thread-state";

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

export type SuggestionFailure = "notAllowed" | "notFound" | "pageLocked" | "pageInTrash";

/**
 * Accepts or rejects suggested edits of the page: `ids`, or every pending one (null). How many it
 * answered comes back (none: they were answered or withdrawn already); the page changes for
 * everyone through its document.
 */
export async function answerSuggestionsAction(pageId: string, decision: Decision, ids: string[] | null) {
  const userId = await requireUserId();
  if (typeof pageId !== "string" || !pageId) return { ok: false as const, code: "notFound" as SuggestionFailure };
  try {
    const answered = await answerSuggestions(userId, pageId, decision, ids);
    return { ok: true as const, count: answered.length };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false as const, code: "notAllowed" as SuggestionFailure };
    if (error instanceof CommentError) return { ok: false as const, code: "notFound" as SuggestionFailure };
    const code = (error as { code?: unknown }).code;
    if (code === "pageLocked" || code === "pageInTrash") return { ok: false as const, code: code as SuggestionFailure };
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

/**
 * The viewer's own state of the page's threads: who they are, which threads they marked to come
 * back to later, and when they last saw each one.
 */
export async function threadStatesAction(pageId: string) {
  const userId = await requireUserId();
  return { viewerId: userId, ...(await threadStates(userId, pageId)) };
}

/** Marks a thread of the page to come back to later, or takes the mark off. */
export async function markThreadAction(pageId: string, threadId: string, marked: boolean) {
  const userId = await requireUserId();
  return setThreadMarked(userId, pageId, threadId, marked);
}

/** The viewer has these threads of the page in front of them now. */
export async function seeThreadsAction(pageId: string, threadIds: string[]) {
  const userId = await requireUserId();
  if (!Array.isArray(threadIds)) return;
  await markThreadsSeen(userId, pageId, threadIds);
}

"use server";

import { AccessError } from "@/server/access";
import * as mentions from "@/server/mentions";
import { requireUserId } from "@/server/session";

/** What the @ menu (and the "Link to page" picker) offers on a page the user may edit. */
export async function mentionCandidatesAction(pageId: string, query: string): Promise<mentions.MentionCandidates> {
  const userId = await requireUserId();
  try {
    return await mentions.mentionCandidates(userId, pageId, query);
  } catch (error) {
    if (error instanceof AccessError) return { people: [], pages: [] };
    throw error;
  }
}

/** Live titles and icons of mentioned pages, as far as the user may see them. */
export async function resolvePagesAction(pageIds: string[]) {
  const userId = await requireUserId();
  return mentions.resolvePageRefs(userId, Array.isArray(pageIds) ? pageIds : []);
}

/** The pages linking to this one that the user can see. */
export async function backlinksAction(pageId: string) {
  const userId = await requireUserId();
  try {
    return await mentions.listBacklinks(userId, pageId);
  } catch (error) {
    if (error instanceof AccessError) return [];
    throw error;
  }
}

/** Pages that write this page's title without linking to it, that the user can see. */
export async function unlinkedMentionsAction(pageId: string) {
  const userId = await requireUserId();
  try {
    return await mentions.listUnlinkedMentions(userId, pageId);
  } catch (error) {
    if (error instanceof AccessError) return [];
    throw error;
  }
}

/**
 * Links the first place `sourceId` writes this page's title. `ok` is false when it couldn't:
 * `locked` when the source is locked, otherwise the title is gone or it may not be edited.
 */
export async function linkMentionAction(sourceId: string, targetId: string): Promise<{ ok: boolean; locked?: boolean }> {
  const userId = await requireUserId();
  try {
    return { ok: await mentions.linkUnlinkedMention(userId, sourceId, targetId) };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false };
    if ((error as { code?: unknown }).code === "pageLocked") return { ok: false, locked: true };
    throw error;
  }
}

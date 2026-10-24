"use server";

import { getTranslations } from "next-intl/server";
import type { PostReaction } from "@/lib/feed";
import { AccessError } from "@/server/access";
import * as feed from "@/server/feed";
import { ReactionError, setReaction } from "@/server/reactions";
import { requireUserId } from "@/server/session";

export type FeedActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** How a post names pages its reader can't open, in their language. */
async function linkLabels(): Promise<feed.LinkLabels> {
  const [t, tc] = await Promise.all([getTranslations("page.mention"), getTranslations("common")]);
  return { untitled: tc("untitled"), noAccess: t("noAccess"), deleted: t("deleted") };
}

async function run<T>(fn: (userId: string) => Promise<T>): Promise<FeedActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (error instanceof ReactionError) return { ok: false, error: t(`database.feed.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error("[feed action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** The bodies, reactions and open comments of the posts a feed view shows (server/feed). */
export async function feedPostsAction(databaseId: string, rowIds: string[]) {
  return run(async (userId) => {
    if (typeof databaseId !== "string" || !Array.isArray(rowIds)) throw new AccessError();
    const { posts, people } = await feed.feedPosts(userId, databaseId, rowIds, await linkLabels());
    if (!people.some((p) => p.isAgent)) return { posts, people };
    const t = await getTranslations("common");
    return { posts, people: people.map((p) => (p.isAgent ? { ...p, username: t("agentName", { name: p.username }) } : p)) };
  });
}

/** A post's whole body, for "Show more". */
export async function feedBodyAction(rowId: string) {
  return run(async (userId) => {
    if (typeof rowId !== "string") throw new AccessError();
    return feed.feedBody(userId, rowId, await linkLabels());
  });
}

/** Leaves a reaction on a row (`on`) or takes it back; the row's reactions as they are now. */
export async function setReactionAction(rowId: string, emoji: string, on: boolean): Promise<FeedActionResult<PostReaction[]>> {
  return run(async (userId) => {
    if (typeof rowId !== "string") throw new AccessError();
    return setReaction(userId, rowId, emoji, on === true);
  });
}

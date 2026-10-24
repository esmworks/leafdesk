"use server";

import { getTranslations } from "next-intl/server";
import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import type { BookmarkProps } from "@/lib/web-blocks";
import { AccessError, requirePageAccess } from "@/server/access";
import { fetchLinkPreview, LinkPreviewError } from "@/server/link-preview";
import { requireUserId } from "@/server/session";
import { urlPropertyPreview, type UrlPreview } from "@/server/url-preview";

/** A bookmark's details; the card keeps the width it has. */
export type LinkPreviewResult = { ok: true; data: Omit<BookmarkProps, "width"> } | { ok: false; error: string };

/**
 * Fetches are made by this server on a user's behalf, so each user gets a budget: enough for
 * pasting links all day, not for using the server as a crawler.
 */
const perMinute = new SlidingWindowLimiter(20, 60_000);
const perHour = new SlidingWindowLimiter(200, 60 * 60_000);

/**
 * The details of a bookmark's page (title, description, image, icon), for a bookmark block of
 * `pageId`. Needs edit access to the page: only people who can write the result into the block
 * may make the server fetch anything. See server/link-preview.ts for what may be fetched.
 */
export async function fetchLinkPreviewAction(pageId: string, url: string): Promise<LinkPreviewResult> {
  const userId = await requireUserId();
  const t = await getTranslations("page.web.errors");
  try {
    await requirePageAccess(userId, pageId, "edit");
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied") };
    throw error;
  }
  if (takeAll([[perMinute, userId], [perHour, userId]]) > 0) return { ok: false, error: t("rateLimited") };
  try {
    const preview = await fetchLinkPreview(url);
    return { ok: true, data: { ...preview, fetchedAt: new Date().toISOString() } };
  } catch (error) {
    if (error instanceof LinkPreviewError) return { ok: false, error: t(error.code) };
    console.error("[link preview]", error);
    return { ok: false, error: t("unreachable") };
  }
}

/**
 * The preview of the link in a URL property of a row, for its row page (server/url-preview.ts):
 * null when the property doesn't show one or there is none to show. Needs view access to the row.
 */
export async function urlPreviewAction(rowId: string, propertyId: string): Promise<{ ok: true; data: UrlPreview | null } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await urlPropertyPreview(userId, String(rowId), String(propertyId)) };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: (await getTranslations("page.web.errors"))("accessDenied") };
    throw error;
  }
}

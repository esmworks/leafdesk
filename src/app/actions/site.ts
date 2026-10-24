"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { AccessError } from "@/server/access";
import { DuplicateError, duplicatePublishedPage } from "@/server/published-duplicate";
import { requireUserId } from "@/server/session";
import { removeSite, saveSite, setSiteListing, SiteError, updateSiteOptions, type SiteOptions, type WorkspaceSiteInfo } from "@/server/site";
import type { ActionResult } from "./workspaces";

// Expected failures come back translated: Next.js hides thrown messages in production.
async function siteRun<T>(workspaceId: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath(`/w/${workspaceId}`, "layout");
    return { ok: true, data };
  } catch (error) {
    const t = await getTranslations("settings.site.errors");
    if (error instanceof SiteError) return { ok: false, error: t(error.code) };
    if (error instanceof AccessError) return { ok: false, error: t("ownersOnly") };
    throw error;
  }
}

export async function saveSiteAction(
  workspaceId: string,
  input: { slug: string; title: string; homePageId: string | null },
): Promise<ActionResult<WorkspaceSiteInfo>> {
  const userId = await requireUserId();
  return siteRun(workspaceId, () => saveSite(userId, workspaceId, input));
}

/** The site's domain, theme, header links, search description or analytics ID. Owners only. */
export async function updateSiteOptionsAction(workspaceId: string, patch: Partial<SiteOptions>): Promise<ActionResult<WorkspaceSiteInfo>> {
  const userId = await requireUserId();
  if (!patch || typeof patch !== "object") throw new Error("Expected the options to change");
  const { domain, theme, description, headerLinks, analyticsId } = patch;
  return siteRun(workspaceId, () => updateSiteOptions(userId, String(workspaceId), { domain, theme, description, headerLinks, analyticsId }));
}

export async function removeSiteAction(workspaceId: string): Promise<ActionResult<undefined>> {
  const userId = await requireUserId();
  return siteRun(workspaceId, async () => {
    await removeSite(userId, workspaceId);
    return undefined;
  });
}

export async function setSiteListingAction(workspaceId: string, pageId: string, inSite: boolean): Promise<ActionResult<undefined>> {
  const userId = await requireUserId();
  return siteRun(workspaceId, async () => {
    await setSiteListing(userId, workspaceId, pageId, inSite);
    return undefined;
  });
}

/**
 * "Duplicate" on a published page (`key` is the address's token or site slug): copies the page into
 * one of the visitor's workspaces and returns where the copy is.
 */
export async function duplicatePublishedAction(input: {
  key: string;
  pageId: string;
  workspaceId: string;
  asTemplate: boolean;
}): Promise<ActionResult<{ url: string }>> {
  const userId = await requireUserId();
  try {
    const copy = await duplicatePublishedPage(
      { userId },
      { key: String(input.key), pageId: String(input.pageId), workspaceId: String(input.workspaceId), asTemplate: input.asTemplate === true },
    );
    revalidatePath(`/w/${copy.workspaceId}`, "layout");
    return { ok: true, data: { url: `/w/${copy.workspaceId}/p/${copy.pageId}` } };
  } catch (error) {
    if (error instanceof DuplicateError) {
      const t = await getTranslations("publish.duplicate.errors");
      return { ok: false, error: t(error.code) };
    }
    throw error;
  }
}

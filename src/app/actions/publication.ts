"use server";

import * as publication from "@/server/publication";
import { outsideDatabases, setOutsideDatabases } from "@/server/publish-reach";
import { requireUserId } from "@/server/session";
import { siteForPage } from "@/server/site";

/** Site path of a published page; the client prefixes its own origin for copying. */
const publicPath = (token: string) => `/s/${token}`;

/**
 * The page's publication, if any, why the viewer can't publish it (null when they can), for
 * databases the views published pages show, the workspace's site (with the page's address
 * there, when it is listed) and the databases its body shows from outside it (see publish-reach).
 */
export async function getPublicationAction(pageId: string) {
  const userId = await requireUserId();
  const [found, blocker, views, site, outside] = await Promise.all([
    publication.getPublication(userId, pageId),
    publication.publishBlocker(userId, pageId),
    publication.getWebViews(userId, pageId),
    siteForPage(userId, pageId),
    outsideDatabases(userId, pageId),
  ]);
  return {
    publication: found
      ? {
          token: found.token,
          url: publicPath(found.token),
          siteUrl: site && found.inSite ? site.pageUrl : null,
          indexable: found.indexable,
          inSite: found.inSite,
          allowDuplicate: found.allowDuplicate,
          description: found.description,
          expiresAt: found.expiresAt?.toISOString() ?? null,
          // Read on the server's clock: an expired link is served nowhere.
          expired: found.expiresAt !== null && found.expiresAt.getTime() <= Date.now(),
          createdAt: found.createdAt,
        }
      : null,
    blocker,
    views,
    site: site ? { url: site.url } : null,
    outside,
  };
}

/** Publishes the page, showing the outside databases `shown` names (see setOutsideDatabases). */
export async function publishPageAction(pageId: string, shown: string[] = []) {
  const userId = await requireUserId();
  await publication.publishPage(userId, pageId);
  if (shown.length) await setOutsideDatabases(userId, pageId, shown);
  return getPublicationAction(pageId);
}

export async function unpublishPageAction(pageId: string) {
  const userId = await requireUserId();
  await publication.unpublishPage(userId, pageId);
}

export async function setPublicationIndexableAction(pageId: string, indexable: boolean) {
  const userId = await requireUserId();
  await publication.setPublicationIndexable(userId, pageId, indexable);
}

/** Changes the publication's options (search engines and description, listing in the site, duplicating). */
export async function updatePublicationAction(pageId: string, patch: Partial<publication.PublicationOptions>) {
  const userId = await requireUserId();
  await publication.updatePublication(userId, pageId, patch);
  return (await getPublicationAction(pageId)).publication;
}

/**
 * Sets when the page's link stops working (an ISO time ahead), or clears it (null). Returns the
 * publication again, or why the time can't be used.
 */
export async function setPublicationExpiryAction(pageId: string, expiresAt: string | null) {
  const userId = await requireUserId();
  if (expiresAt !== null && typeof expiresAt !== "string") return { ok: false as const, error: "expiryInvalid" as const };
  try {
    await publication.updatePublication(userId, pageId, { expiresAt });
  } catch (error) {
    if (error instanceof publication.PublishError && (error.code === "expiryPast" || error.code === "expiryTooFar")) {
      return { ok: false as const, error: error.code };
    }
    throw error;
  }
  return { ok: true as const, publication: (await getPublicationAction(pageId)).publication };
}

/** Which databases from outside the page its publication shows; returns them all again. */
export async function setOutsideDatabasesAction(pageId: string, shown: string[]) {
  const userId = await requireUserId();
  await setOutsideDatabases(userId, pageId, shown);
  return outsideDatabases(userId, pageId);
}

export async function setWebViewsAction(databaseId: string, viewIds: string[]) {
  const userId = await requireUserId();
  await publication.setWebViews(userId, databaseId, viewIds);
  return publication.getWebViews(userId, databaseId);
}

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

/** Changes the publication's options (search engines, listing in the site, duplicating). */
export async function updatePublicationAction(pageId: string, patch: Partial<publication.PublicationOptions>) {
  const userId = await requireUserId();
  await publication.updatePublication(userId, pageId, patch);
  return (await getPublicationAction(pageId)).publication;
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

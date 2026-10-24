import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";
import { policyNonce } from "@/lib/content-security-policy";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { emojiIcon, isSiteKey, pageIdFromSegment, publishedHref, SITE_ANALYTICS_HEADER, SITE_HOST_HEADER } from "@/lib/site";
import { getPublishedPage, type PublishedPage } from "@/server/publication";
import { getSitePage, loadSite, type PublicSite } from "@/server/site";

/**
 * `/s/<key>/…` serves two kinds of addresses: a publication's link (`key` is its token, pages by
 * id) and a workspace's site (`key` is its slug, pages by `<title>-<id>`); see lib/site.ts. A site
 * with a domain of its own is also served at that domain's root (proxy.ts rewrites to here).
 */
export type LoadedPage = {
  key: string;
  data: PublishedPage;
  site: PublicSite | null;
  /** The site's Google Analytics ID, when the response's policy lets its tag in (see proxy.ts). */
  analyticsId: string | null;
  /** This response's script nonce. */
  nonce: string | undefined;
};

/** The published page for a request, shared by metadata and the page; 404 when it isn't public. */
export const loadPublished = cache(async (key: string, segment?: string, viewId?: string): Promise<LoadedPage> => {
  const requestHeaders = await headers();
  const nonce = policyNonce(requestHeaders.get("content-security-policy"));
  if (isSiteKey(key)) {
    // server.ts names the site whose own domain the request came for, and drops the header otherwise.
    const site = await loadSite(key, { onDomain: requestHeaders.get(SITE_HOST_HEADER) === key });
    if (!site) notFound();
    const pageId = segment === undefined ? undefined : pageIdFromSegment(segment);
    if (segment !== undefined && !pageId) notFound();
    const found = await getSitePage(site, pageId ?? undefined, viewId);
    if (!found) notFound();
    const allowed = site.analyticsId && requestHeaders.get(SITE_ANALYTICS_HEADER) === site.analyticsId;
    return { key, ...found, analyticsId: allowed ? site.analyticsId : null, nonce };
  }
  const data = await getPublishedPage(key, segment, viewId);
  if (!data) notFound();
  return { key, data, site: null, analyticsId: null, nonce };
});

/** `?view=<id>`: which of a published database's views to show. */
export const viewParam = (value: string | string[] | undefined) => (typeof value === "string" && value.length <= 64 ? value : undefined);

/** Site pages live at one address: others (an old title, the home page by id) lead there. */
export function redirectToCanonical({ data, site }: LoadedPage, segment: string | undefined, viewId: string | undefined) {
  if (!site) return;
  const canonical = publishedHref(data.links, data.id, data.title);
  const current = segment === undefined ? data.links.base || "/" : `${data.links.base}/${segment}`;
  if (canonical !== current) redirect(viewId ? `${canonical}?view=${encodeURIComponent(viewId)}` : canonical);
}

/**
 * The address search engines should know a site's page by: on the site's own domain when it has
 * one (served over HTTPS, see README), else at the app's address.
 */
function canonicalUrl({ data, site }: Pick<LoadedPage, "data" | "site">): string | undefined {
  if (!site) return undefined;
  if (site.domain) return `https://${site.domain}${publishedHref({ ...data.links, base: "" }, data.id, data.title)}`;
  return `${env.appUrl}${publishedHref({ ...data.links, base: `/s/${site.slug}` }, data.id, data.title)}`;
}

export async function publishedMetadata(key: string, segment?: string, viewId?: string): Promise<Metadata> {
  const [loaded, tc] = await Promise.all([loadPublished(key, segment, viewId), getTranslations("common")]);
  const { data, site } = loaded;
  const title = pageLabel(data.title, tc("untitled"));
  const full = data.icon ? `${data.icon} ${title}` : title;
  const shown = site?.title && data.id !== site.homeId ? `${full} · ${site.title}` : full;
  const description = data.description || site?.description || undefined;
  const canonical = canonicalUrl(loaded);
  const favicon = site && emojiIcon(site.homeIcon);
  return {
    // A site is its owner's: its pages' titles don't end in the app's name.
    title: site ? { absolute: shown } : shown,
    description,
    // The layout keeps published pages out of search engines unless the publisher allowed them.
    ...(data.indexable ? { robots: { index: true, follow: true } } : {}),
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: { type: "website", title: shown, description, url: canonical, siteName: site?.title || undefined },
    twitter: { card: "summary", title: shown, description },
    // The home page's emoji, drawn by favicon.svg; the version makes browsers fetch a new one.
    ...(favicon
      ? {
          icons: {
            icon: [{ url: `${data.links.base}/favicon.svg?v=${[...favicon].map((c) => c.codePointAt(0)!.toString(16)).join("-")}`, type: "image/svg+xml" }],
          },
        }
      : {}),
  };
}

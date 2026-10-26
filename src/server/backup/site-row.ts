import {
  cleanDescription,
  cleanHeaderLinks,
  isAnalyticsId,
  isSiteTheme,
  normalizeSiteDomain,
  siteDomainProblem,
  siteSlugProblem,
} from "@/lib/site";

/**
 * A workspace's site as a backup holds it (a `workspace_site` row), checked as saving it here would
 * check it (server/site.ts), since a backup file can be edited: null when its address can't be a
 * site's; a domain, analytics ID, theme or header links that don't pass are dropped, a title and a
 * description cut to what can be saved. `pageIds`: the pages the backup holds, the only ones header
 * links may lead to; `appHost`: this server's own host, never a site's domain.
 */
export function restoredSite(row: Record<string, unknown>, { appHost, pageIds }: { appHost: string; pageIds: ReadonlySet<string> }): Record<string, unknown> | null {
  const slug = typeof row.slug === "string" ? row.slug.trim().toLowerCase() : "";
  if (siteSlugProblem(slug)) return null;
  const typedDomain = typeof row.domain === "string" ? normalizeSiteDomain(row.domain) : null;
  const domain = typedDomain && !siteDomainProblem(typedDomain, appHost) ? typedDomain : null;
  const analytics = typeof row.analytics_id === "string" ? row.analytics_id.trim().toUpperCase() : "";
  const links = (cleanHeaderLinks(row.header_links) ?? []).filter((link) => !("pageId" in link) || pageIds.has(link.pageId));
  return {
    ...row,
    slug,
    title: typeof row.title === "string" ? row.title.trim().slice(0, 80) : "",
    domain,
    theme: isSiteTheme(row.theme) ? row.theme : "system",
    description: cleanDescription(row.description),
    header_links: links,
    analytics_id: isAnalyticsId(analytics) ? analytics : null,
  };
}

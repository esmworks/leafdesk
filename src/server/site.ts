import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pagePublication, workspaceSite, type PageKind } from "@/db/schema";
import { isSiteKey, publishedHref, siteSlugProblem, type PublishedLinks, type SiteSlugProblem } from "@/lib/site";
import { accessRank, pageVisibleTo, requireMember, requireMembership, requirePageAccess } from "@/server/access";
import { changedValues, recordAudit } from "@/server/audit";
import { chainTo, getPublishedPage, type PublishedPage } from "@/server/publication";
import { publishingOn } from "@/server/workspaces";
import { refuseInLocalMode } from "@/server/local-mode";
import { env } from "@/lib/env";

/**
 * Workspace sites: a readable address for a workspace's published pages.
 *
 * - An owner picks a slug (`/s/<slug>`, see lib/site.ts), a title and a home page among the
 *   workspace's published pages. Members can see the settings; guests can't.
 * - The site lists the publications marked `inSite` (the home page is marked when it is picked).
 *   Its navigation shows each of them with its subpages, and `/s/<slug>/<title>-<id>` serves any
 *   page one of them serves. A page shared by link only (not listed) is never reachable through
 *   the site, nor named by it.
 * - Everything a site shows is what the publications show: pages their publishers can see, live,
 *   outside templates (see publication.chainTo). Search engines follow each publication's own
 *   setting.
 * - While the workspace has publishing turned off, the site is not found; its settings stay.
 * - Publication links (`/s/<token>/…`) keep working as before.
 */

/** Deepest level under a listed page that the navigation shows; deeper pages are still served. */
const NAV_DEPTH = 3;
/** Most pages the navigation of one listed page shows. */
const NAV_PAGES = 300;
/** Most listed publications a site shows. */
const MAX_LISTED = 200;

export class SiteError extends Error {
  constructor(
    message: string,
    readonly code: SiteSlugProblem | "slugTaken" | "homeNotPublished",
  ) {
    super(message);
    this.name = "SiteError";
  }
}

export type WorkspaceSiteInfo = { slug: string; title: string; homePageId: string | null; url: string };

const siteUrl = (slug: string) => `/s/${slug}`;

/** The workspace's site, or null when it has none. Owners and members. */
export async function getSite(userId: string, workspaceId: string): Promise<WorkspaceSiteInfo | null> {
  await requireMember(userId, workspaceId);
  const [row] = await db
    .select({ slug: workspaceSite.slug, title: workspaceSite.title, homePageId: workspaceSite.homePageId })
    .from(workspaceSite)
    .where(eq(workspaceSite.workspaceId, workspaceId))
    .limit(1);
  return row ? { ...row, url: siteUrl(row.slug) } : null;
}

/**
 * Sets up the workspace's site or changes it. Owners only. The slug must be free and not reserved;
 * the home page, when given, must be a published page of the workspace the owner can see, and
 * becomes listed in the site.
 */
export async function saveSite(
  userId: string,
  workspaceId: string,
  input: { slug: string; title: string; homePageId: string | null },
): Promise<WorkspaceSiteInfo> {
  refuseInLocalMode();
  await requireMembership(userId, workspaceId, "owner");
  const slug = String(input.slug ?? "").trim().toLowerCase();
  const problem = siteSlugProblem(slug);
  if (problem) throw new SiteError(`The address "${slug}" can't be used (${problem})`, problem);
  const title = String(input.title ?? "").trim().slice(0, 80);
  const homePageId = input.homePageId || null;
  if (homePageId) {
    const [home] = await db
      .select({ id: page.id })
      .from(pagePublication)
      .innerJoin(page, eq(page.id, pagePublication.pageId))
      .where(
        and(
          eq(pagePublication.pageId, homePageId),
          eq(page.workspaceId, workspaceId),
          isNull(page.archivedAt),
          sql`${accessRank(userId, sql`${page.id}`)} > 0`,
        ),
      )
      .limit(1);
    if (!home) throw new SiteError("Pick a published page of this workspace as the home page", "homeNotPublished");
  }
  const [taken] = await db
    .select({ workspaceId: workspaceSite.workspaceId })
    .from(workspaceSite)
    .where(eq(workspaceSite.slug, slug))
    .limit(1);
  if (taken && taken.workspaceId !== workspaceId) throw new SiteError(`The address "${slug}" is taken`, "slugTaken");
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ slug: workspaceSite.slug, title: workspaceSite.title, homePageId: workspaceSite.homePageId })
        .from(workspaceSite)
        .where(eq(workspaceSite.workspaceId, workspaceId));
      await tx
        .insert(workspaceSite)
        .values({ workspaceId, slug, title, homePageId })
        .onConflictDoUpdate({ target: workspaceSite.workspaceId, set: { slug, title, homePageId, updatedAt: new Date() } });
      if (homePageId) await tx.update(pagePublication).set({ inSite: true }).where(eq(pagePublication.pageId, homePageId));
      const changes = changedValues<Record<string, unknown>>(before ?? {}, { slug, title, homePageId });
      if (!before || Object.keys(changes).length) {
        await recordAudit(
          { workspaceId, actorId: userId, action: "site.saved", target: { type: "site", id: slug, label: slug }, details: { slug, created: !before, changes } },
          tx,
        );
      }
    });
  } catch (error) {
    // Another workspace took the slug in the meantime.
    if ((error as { cause?: { code?: string } }).cause?.code === "23505" || (error as { code?: string }).code === "23505") {
      throw new SiteError(`The address "${slug}" is taken`, "slugTaken");
    }
    throw error;
  }
  return { slug, title, homePageId, url: siteUrl(slug) };
}

/**
 * Lists a published page of the workspace in its site, or takes it out. Owners only, for any
 * publication of the workspace (as they may take any offline); listing needs a page they can see.
 * Publishers change their own pages from the Publish tab (publication.updatePublication).
 */
export async function setSiteListing(userId: string, workspaceId: string, pageId: string, inSite: boolean): Promise<void> {
  refuseInLocalMode();
  await requireMembership(userId, workspaceId, "owner");
  const [found] = await db
    .select({ visible: sql<boolean>`${accessRank(userId, sql`${page.id}`)} > 0`, archivedAt: page.archivedAt })
    .from(pagePublication)
    .innerJoin(page, eq(page.id, pagePublication.pageId))
    .where(and(eq(pagePublication.pageId, pageId), eq(page.workspaceId, workspaceId)))
    .limit(1);
  if (!found) throw new SiteError("The page isn't published", "homeNotPublished");
  if (inSite && (!found.visible || found.archivedAt)) throw new SiteError("Only pages you can see can be listed", "homeNotPublished");
  await db.update(pagePublication).set({ inSite }).where(eq(pagePublication.pageId, pageId));
}

/**
 * The site of a page's workspace, for its Publish tab: its address, and the page's address there
 * (`pageUrl`, whether or not the page is listed). Null when the workspace has no site. Needs view
 * access to the page.
 */
export async function siteForPage(userId: string, pageId: string): Promise<{ url: string; pageUrl: string } | null> {
  const p = await requirePageAccess(userId, pageId, "view");
  const [row] = await db
    .select({ slug: workspaceSite.slug, homePageId: workspaceSite.homePageId })
    .from(workspaceSite)
    .where(eq(workspaceSite.workspaceId, p.workspaceId))
    .limit(1);
  if (!row) return null;
  const url = siteUrl(row.slug);
  return { url, pageUrl: publishedHref({ base: url, homeId: row.homePageId ?? "", site: true }, pageId, p.title) };
}

/** Takes the site down; its pages keep their own links. Owners only. */
export async function removeSite(userId: string, workspaceId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const removed = await db.delete(workspaceSite).where(eq(workspaceSite.workspaceId, workspaceId)).returning({ slug: workspaceSite.slug });
  for (const { slug } of removed) {
    await recordAudit({ workspaceId, actorId: userId, action: "site.removed", target: { type: "site", id: slug, label: slug }, details: { slug } });
  }
}

// ---------------------------------------------------------------------------------------------
// Public reads (no user): everything below trusts only the slug and what publications serve.

type Listed = { pageId: string; token: string; publisher: string; title: string; icon: string | null; kind: PageKind; allowDuplicate: boolean };

export type SiteNavNode = { id: string; title: string; icon: string | null; kind: PageKind; href: string; children: SiteNavNode[] };

export type PublicSite = {
  slug: string;
  title: string;
  /** The page `/s/<slug>` opens; null when the site lists nothing it can serve. */
  homeId: string | null;
  links: PublishedLinks;
  /** Listed pages (the home page first), each with its subpages. */
  nav: SiteNavNode[];
};

/**
 * A site as its visitors see it, with what it takes to resolve its pages. Cached per request by
 * the route (see app/s/[token]/load.ts).
 */
export type SiteContext = PublicSite & {
  /** The listed publication serving `pageId` (the outermost one, when several do), or null. */
  servingPublication: (pageId: string) => Promise<Listed | null>;
};

/** Listed publications of the workspace that are still served: live, and visible to their publisher. */
async function listedPublications(workspaceId: string): Promise<Listed[]> {
  const rows = await db
    .select({
      pageId: page.id,
      token: pagePublication.token,
      publisher: pagePublication.publishedBy,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      allowDuplicate: pagePublication.allowDuplicate,
    })
    .from(pagePublication)
    .innerJoin(page, eq(page.id, pagePublication.pageId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(pagePublication.inSite, true),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
        isNotNull(pagePublication.publishedBy),
      ),
    )
    .limit(MAX_LISTED);
  const served = await Promise.all(
    rows.map(async (r) => ((await chainTo(r.publisher!, r.pageId, r.pageId)) ? ({ ...r, publisher: r.publisher! } as Listed) : null)),
  );
  return served.filter((r): r is Listed => r !== null);
}

/** Ancestors of `pageId` (itself first, then up), at most as deep as publications serve. */
async function ancestorsOf(pageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!pageIds.length) return out;
  const rows = await db.execute<{ start: string; id: string; depth: number }>(sql`
    with recursive up as (
      select id, parent_id, id as start, 0 as depth from ${page} where ${inArray(page.id, pageIds)}
      union all
      select p.id, p.parent_id, up.start, up.depth + 1
      from ${page} p join up on p.id = up.parent_id
      where up.depth < 32
    )
    select start, id, depth from up order by start, depth
  `);
  for (const row of rows) out.set(row.start, [...(out.get(row.start) ?? []), row.id]);
  return out;
}

/** The site with this slug, or null. */
export async function loadSite(slug: string): Promise<SiteContext | null> {
  if (!isSiteKey(slug) || env.localMode) return null;
  const [site] = await db.select().from(workspaceSite).where(eq(workspaceSite.slug, slug)).limit(1);
  // Publishing turned off: the site is not found, as if it had none, until it is turned back on.
  if (!site || !(await publishingOn(site.workspaceId))) return null;

  const listed = await listedPublications(site.workspaceId);
  const byPage = new Map(listed.map((l) => [l.pageId, l]));

  const serving = new Map<string, Promise<Listed | null>>();
  const servingPublication = (pageId: string) => {
    let found = serving.get(pageId);
    if (!found) {
      found = (async () => {
        const chain = (await ancestorsOf([pageId])).get(pageId) ?? [];
        // Outermost first: a page under two listed pages belongs to the higher one.
        for (const id of [...chain].reverse()) {
          const candidate = byPage.get(id);
          if (candidate && (await chainTo(candidate.publisher, pageId, candidate.pageId))) return candidate;
        }
        return null;
      })();
      serving.set(pageId, found);
    }
    return found;
  };

  // Listed pages that another listed page serves show under it, not again at the top.
  const tops: Listed[] = [];
  for (const entry of listed) {
    const owner = await servingPublication(entry.pageId);
    if (!owner || owner.pageId === entry.pageId) tops.push(entry);
  }

  const home = site.homePageId && (await servingPublication(site.homePageId)) ? site.homePageId : null;
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  tops.sort((a, b) => (a.pageId === home ? -1 : b.pageId === home ? 1 : collator.compare(a.title, b.title)));
  const homeId = home ?? tops[0]?.pageId ?? null;
  const links: PublishedLinks = { base: siteUrl(site.slug), homeId: homeId ?? "", site: true };
  const nav = await Promise.all(tops.map((entry) => navTree(entry, links)));

  return { slug: site.slug, title: site.title, homeId, links, nav, servingPublication };
}

/** A listed page and its subpages as the navigation shows them (not database rows). */
async function navTree(entry: Listed, links: PublishedLinks): Promise<SiteNavNode> {
  const rows = await db.execute<{ id: string; parent_id: string | null; title: string; icon: string | null; kind: PageKind }>(sql`
    with recursive sub as (
      select id, kind, 0 as depth from ${page} where id = ${entry.pageId}
      union all
      select p.id, p.kind, sub.depth + 1
      from ${page} p join sub on p.parent_id = sub.id
      where sub.kind <> 'database' and sub.depth < ${NAV_DEPTH}
        and p.archived_at is null and not p.in_template and ${pageVisibleTo(entry.publisher, "p")}
    )
    select p.id, p.parent_id, p.title, p.icon, p.kind
    from (select id from sub where id <> ${entry.pageId} limit ${NAV_PAGES}) s
    join ${page} p on p.id = s.id
    order by p.position, p.created_at
  `);
  const nodes = new Map<string, SiteNavNode>();
  const node = (id: string, title: string, icon: string | null, kind: PageKind): SiteNavNode => ({
    id,
    title,
    icon,
    kind,
    href: publishedHref(links, id, title),
    children: [],
  });
  const root = node(entry.pageId, entry.title, entry.icon, entry.kind);
  nodes.set(root.id, root);
  for (const row of rows) nodes.set(row.id, node(row.id, row.title, row.icon, row.kind));
  for (const row of rows) {
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children.push(nodes.get(row.id)!);
  }
  return root;
}

export type SitePage = { site: PublicSite; data: PublishedPage };

/**
 * A page of the site: its home page without `pageId`, else the page when a listed publication
 * serves it. Null otherwise (no such site, nothing listed, a page outside what the site serves).
 */
export async function getSitePage(site: SiteContext, pageId?: string, viewId?: string): Promise<SitePage | null> {
  const targetId = pageId ?? site.homeId;
  if (!targetId) return null;
  const publication = await site.servingPublication(targetId);
  if (!publication) return null;
  const data = await getPublishedPage(publication.token, targetId === publication.pageId ? undefined : targetId, viewId, {
    links: site.links,
    elsewhere: async (id) => (await site.servingPublication(id)) !== null,
  });
  if (!data) return null;
  const { servingPublication: _, ...shown } = site;
  return { site: shown, data };
}

/**
 * The publication behind a public address (`/s/<token or slug>` and a page), when it serves that
 * page: what Duplicate copies from. Null otherwise.
 */
export async function servedPublication(key: string, pageId?: string): Promise<ServedPublication | null> {
  if (env.localMode) return null;
  if (isSiteKey(key)) {
    const site = await loadSite(key);
    const targetId = pageId ?? site?.homeId;
    if (!site || !targetId) return null;
    const publication = await site.servingPublication(targetId);
    return publication
      ? {
          token: publication.token,
          rootId: publication.pageId,
          pageId: targetId,
          publisher: publication.publisher,
          allowDuplicate: publication.allowDuplicate,
          links: site.links,
          elsewhere: async (id) => (await site.servingPublication(id)) !== null,
        }
      : null;
  }
  if (!key || key.length > 128) return null;
  const [root] = await db
    .select({ id: page.id, publisher: pagePublication.publishedBy, allowDuplicate: pagePublication.allowDuplicate })
    .from(pagePublication)
    .innerJoin(page, eq(page.id, pagePublication.pageId))
    .where(and(eq(pagePublication.token, key), isNull(page.archivedAt)))
    .limit(1);
  if (!root?.publisher) return null;
  const targetId = pageId ?? root.id;
  if (!(await chainTo(root.publisher, targetId, root.id))) return null;
  return {
    token: key,
    rootId: root.id,
    pageId: targetId,
    publisher: root.publisher,
    allowDuplicate: root.allowDuplicate,
    links: { base: `/s/${key}`, homeId: root.id, site: false },
    elsewhere: async () => false,
  };
}

export type ServedPublication = {
  token: string;
  /** The published page. */
  rootId: string;
  /** The page asked for, under it. */
  pageId: string;
  publisher: string;
  allowDuplicate: boolean;
  /** How the address links to pages: the publication's link or the site. */
  links: PublishedLinks;
  /** Whether another publication of the site serves a page. */
  elsewhere: (pageId: string) => Promise<boolean>;
};

import { eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { workspaceSite } from "@/db/schema";
import { env } from "@/lib/env";
import { isSiteTheme, requestHost, routeOnSiteHost, sitePathSlug, type SiteHostRoute, type SiteTheme } from "@/lib/site";

/**
 * Which requests belong to a workspace site with a domain of its own or an analytics ID, for
 * server.ts, which sees every request (API routes and websocket upgrades included) before Next.
 *
 * The sites that have either are read all at once and kept for a short while, so a request costs a
 * map lookup: any host can be sent, and none of them makes a query. Saving a site forgets them
 * (forgetSiteHosts); other servers on the same database catch up within SNAPSHOT_MS. The snapshot
 * lives on globalThis because server.ts and Next's bundle each load this module.
 */

const SNAPSHOT_MS = 15_000;

type SiteHost = { slug: string; domain: string | null; analyticsId: string | null };
type Snapshot = { at: number; byDomain: Map<string, SiteHost>; bySlug: Map<string, SiteHost> };

const store = globalThis as unknown as { __leafdeskSiteHosts?: { snapshot?: Snapshot; loading?: Promise<Snapshot>; generation: number } };
const state = (store.__leafdeskSiteHosts ??= { generation: 0 });

async function load(): Promise<Snapshot> {
  const generation = state.generation;
  const rows = await db
    .select({ slug: workspaceSite.slug, domain: workspaceSite.domain, analyticsId: workspaceSite.analyticsId })
    .from(workspaceSite)
    .where(or(isNotNull(workspaceSite.domain), isNotNull(workspaceSite.analyticsId)));
  const snapshot: Snapshot = { at: Date.now(), byDomain: new Map(), bySlug: new Map() };
  for (const row of rows) {
    if (row.domain) snapshot.byDomain.set(row.domain, row);
    snapshot.bySlug.set(row.slug, row);
  }
  // A save while this was loading: the next request reads again.
  if (generation === state.generation) state.snapshot = snapshot;
  return snapshot;
}

function snapshot(): Promise<Snapshot> | Snapshot {
  const current = state.snapshot;
  if (current && Date.now() - current.at < SNAPSHOT_MS) return current;
  state.loading ??= load().finally(() => {
    state.loading = undefined;
  });
  // A stale snapshot keeps serving while the next one loads; the first request waits for it.
  return current ?? state.loading;
}

/** Drops the snapshot: a site's domain or analytics ID changed. */
export function forgetSiteHosts() {
  state.generation++;
  state.snapshot = undefined;
  state.loading = undefined;
}

export type SiteGate =
  /** As before: not a site's domain. `analyticsId` when the path is a page of a site that has one. */
  | { kind: "app"; analyticsId: string | null }
  /** A page of the site on its own domain. */
  | { kind: "site"; slug: string; analyticsId: string | null }
  | Exclude<SiteHostRoute, { kind: "site" }>;

const appHost = () => new URL(env.appUrl).hostname.toLowerCase();

/** What server.ts does with a request: see SiteGate. */
export async function siteGate(method: string, url: string, hostHeader: string | undefined): Promise<SiteGate> {
  const host = requestHost(hostHeader);
  const pathname = url.split("?")[0];
  const sitePath = pathname.startsWith("/s/");
  // The app's own address never serves a site at its root, whatever is stored.
  const ownHost = host === appHost();
  if (env.localMode || (ownHost && !sitePath)) return { kind: "app", analyticsId: null };
  const sites = await snapshot();
  const site = ownHost ? undefined : sites.byDomain.get(host);
  if (!site) {
    const slug = sitePath ? sitePathSlug(pathname) : null;
    return { kind: "app", analyticsId: (slug && sites.bySlug.get(slug)?.analyticsId) || null };
  }
  const route = routeOnSiteHost(method, url, site.slug, env.appUrl);
  return route.kind === "site" ? { kind: "site", slug: site.slug, analyticsId: site.analyticsId } : route;
}

/** Whether a websocket upgrade may go ahead on this host: on a site's domain, only Next's own (development). */
export async function upgradeAllowed(url: string, hostHeader: string | undefined): Promise<boolean> {
  const host = requestHost(hostHeader);
  if (env.localMode || host === appHost()) return true;
  const site = (await snapshot()).byDomain.get(host);
  return !site || url.startsWith("/_next/");
}

/**
 * The theme of the site with this slug, for the root layout of its pages; null when there is no
 * such site ("system" when it follows the visitor's system).
 */
export async function siteTheme(slug: string): Promise<SiteTheme | null> {
  if (env.localMode) return null;
  const [row] = await db.select({ theme: workspaceSite.theme }).from(workspaceSite).where(eq(workspaceSite.slug, slug)).limit(1);
  return row ? (isSiteTheme(row.theme) ? row.theme : "system") : null;
}

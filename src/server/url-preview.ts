import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import { requirePageAccess } from "@/server/access";
import { getProperties } from "@/server/databases";
import { fetchLinkPreview, type LinkPreview } from "@/server/link-preview";
import { propertyAccessFor } from "@/server/property-access";

/**
 * Previews of the links in URL properties set to show as one (the property's `url.preview`): the
 * linked page's icon, title and image on row pages. The address is the one stored in the row, read
 * here as the viewer may see it, never one the browser sends, and fetched with the same checks as
 * bookmarks (server/link-preview.ts). Previews are kept a while for everyone, so a database full
 * of the same links fetches each once; only fetches count towards a person's budget.
 */

/** What a row page shows; null when there is nothing to show (no title, image or icon, or the fetch failed). */
export type UrlPreview = Pick<LinkPreview, "url" | "title" | "siteName" | "image" | "favicon">;

const KEPT_MS = 24 * 60 * 60_000;
const FAILED_KEPT_MS = 60 * 60_000;
const MAX_KEPT = 2_000;

type Kept = { until: number; preview: Promise<UrlPreview | null> };

const KEY = "__leafdeskUrlPreviews";
const kept = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Kept>()) as Map<string, Kept>;

// Fetches made for one person: as many as opening rows all day takes, not a crawler's worth.
const perMinute = new SlidingWindowLimiter(30, 60_000);
const perHour = new SlidingWindowLimiter(300, 60 * 60_000);

/** The preview of the link in `propertyId` of row `rowId`, as `userId` may see it. Throws AccessError. */
export async function urlPropertyPreview(
  userId: string,
  rowId: string,
  propertyId: string,
  fetch: (url: string) => Promise<LinkPreview> = fetchLinkPreview,
  now = Date.now(),
): Promise<UrlPreview | null> {
  const row = await requirePageAccess(userId, rowId, "view");
  if (!row.parentId) return null;
  const [properties, access] = await Promise.all([getProperties(row.parentId), propertyAccessFor(userId, row.parentId)]);
  const prop = access.visible(properties).find((p) => p.id === propertyId);
  if (prop?.type !== "url" || !prop.options.url?.preview) return null;
  const [seen] = access.strip([{ properties: row.properties, createdBy: row.createdBy }]);
  const url = seen.properties[propertyId];
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return previewOf(userId, url, fetch, now);
}

async function previewOf(userId: string, url: string, fetch: (url: string) => Promise<LinkPreview>, now: number) {
  const known = kept.get(url);
  if (known && known.until > now) return known.preview;
  if (takeAll([[perMinute, userId], [perHour, userId]], now) > 0) return null;
  const preview = fetch(url).then(
    (found): UrlPreview | null =>
      found.title || found.image || found.siteName
        ? { url, title: found.title, siteName: found.siteName, image: found.image, favicon: found.favicon }
        : null,
    () => null,
  );
  keep(url, { until: now + KEPT_MS, preview });
  // A failure is tried again sooner.
  void preview.then((found) => {
    if (!found && kept.get(url)?.preview === preview) keep(url, { until: now + FAILED_KEPT_MS, preview });
  });
  return preview;
}

function keep(url: string, entry: Kept) {
  kept.delete(url);
  kept.set(url, entry);
  // The oldest go first.
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}

/** Tests only: forgets every kept preview. */
export function forgetUrlPreviews() {
  kept.clear();
}

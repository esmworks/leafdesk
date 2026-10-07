import { fileIdOf, fileUrl } from "./files";

/**
 * A page's cover: the wide picture above its icon and title. Either an image (a file uploaded to
 * the page, or a link to one on the web) shown at a chosen height, or one of the built-in
 * gradients. Kept in the `page.cover` column, next to the icon; uploaded covers count as files the
 * page uses (drizzle trigger `sync_file_references`), so they stay as long as the page shows them.
 *
 * Pure helpers only, shared by the server, the editor and the published pages.
 */
export type PageCover = { kind: "image"; url: string; y: number } | { kind: "gradient"; gradient: CoverGradient };

/** The built-in covers, as CSS backgrounds. The same in both themes: a cover is a picture. */
export const COVER_GRADIENTS = {
  forest: "linear-gradient(135deg, #1d4d33 0%, #2f7d4f 50%, #8cc79f 100%)",
  lagoon: "linear-gradient(135deg, #0b3b52 0%, #12728f 50%, #6cc4c7 100%)",
  dusk: "linear-gradient(135deg, #2a2350 0%, #5b4a9e 50%, #d58fb5 100%)",
  ember: "linear-gradient(135deg, #5c1d16 0%, #c2452d 50%, #f2a65a 100%)",
  sky: "linear-gradient(180deg, #2f6fb4 0%, #6fa8dc 55%, #d6e8f5 100%)",
  meadow: "linear-gradient(135deg, #3d5a1e 0%, #7fa83a 55%, #e0e7a3 100%)",
  berry: "linear-gradient(135deg, #4a1032 0%, #9c2a63 50%, #e58bb0 100%)",
  slate: "linear-gradient(135deg, #1f2328 0%, #4a5361 50%, #9aa5b4 100%)",
} as const;

export type CoverGradient = keyof typeof COVER_GRADIENTS;
export const COVER_GRADIENT_NAMES = Object.keys(COVER_GRADIENTS) as CoverGradient[];

/** Where an image sits vertically when the cover shows only a band of it: 0 top, 100 bottom. */
export const DEFAULT_COVER_Y = 50;

/** Longest link a cover may point at, like other stored URLs. */
export const MAX_COVER_URL_LENGTH = 2048;

const isGradient = (value: unknown): value is CoverGradient =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(COVER_GRADIENTS, value);

const clampY = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value * 10) / 10)) : DEFAULT_COVER_Y;

/**
 * An image URL a cover may show: a file uploaded to this server (kept as its relative path, so it
 * survives APP_URL changes and is counted as used), or an http(s) link. Null for anything else.
 */
export function coverImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const fileId = fileIdOf(trimmed);
  if (fileId) return fileUrl(fileId);
  if (!trimmed || trimmed.length > MAX_COVER_URL_LENGTH) return null;
  const url = URL.parse(trimmed);
  return url && (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
}

/** A stored or submitted cover, checked; anything that isn't one reads as no cover. */
export function parsePageCover(value: unknown): PageCover | null {
  if (!value || typeof value !== "object") return null;
  const cover = value as Record<string, unknown>;
  if (cover.kind === "gradient") return isGradient(cover.gradient) ? { kind: "gradient", gradient: cover.gradient } : null;
  if (cover.kind === "image") {
    const url = coverImageUrl(cover.url);
    return url ? { kind: "image", url, y: clampY(cover.y) } : null;
  }
  return null;
}

/**
 * A cover written as one string, as MCP, the REST API and Markdown exports carry it: an image URL
 * (`/api/files/<id>` or a link), or `gradient:<name>`. Null when it is none of those.
 */
export function parseCoverText(value: string, y?: number): PageCover | null {
  const text = value.trim();
  if (text.startsWith("gradient:")) {
    const gradient = text.slice("gradient:".length);
    return isGradient(gradient) ? { kind: "gradient", gradient } : null;
  }
  const url = coverImageUrl(text);
  return url ? { kind: "image", url, y: clampY(y) } : null;
}

/** The cover as one string (see parseCoverText). */
export function coverText(cover: PageCover): string {
  return cover.kind === "gradient" ? `gradient:${cover.gradient}` : cover.url;
}

/** The CSS `object-position` of an image cover. */
export const coverObjectPosition = (y: number) => `center ${clampY(y)}%`;

/** The uploaded file an image cover shows, if it is one (the trigger in drizzle/0042 does the same). */
export function coverFileId(cover: PageCover | null | undefined): string | null {
  if (cover?.kind !== "image") return null;
  return /^\/api\/files\/([A-Za-z0-9_-]{24})$/.exec(cover.url)?.[1] ?? null;
}

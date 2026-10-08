import { fileIdOf, fileUrl } from "./files";

/**
 * A page's background: what fills the page behind its title and body. Either a color, a light tint
 * in the light theme and a dark one in the dark theme (the option palette's `tint-*` classes), or
 * an image (a file uploaded to the page, or a link to one on the web) covering the page, with the
 * text on a plain surface over it so it stays readable. Kept in the `page.background` column, next
 * to the icon; uploaded images count as files the page uses (drizzle trigger
 * `sync_file_references`), so they stay as long as the page shows them.
 *
 * Pure helpers only, shared by the server, the editor and the published pages.
 */
export type PageBackground = { kind: "color"; color: BackgroundColor } | { kind: "image"; url: string };

/** The colors a page can take, in the order the picker shows them. */
export const BACKGROUND_COLORS = ["gray", "blue", "green", "purple", "pink", "red", "orange"] as const;
export type BackgroundColor = (typeof BACKGROUND_COLORS)[number];

/** Longest link a background may point at, like other stored URLs. */
export const MAX_BACKGROUND_URL_LENGTH = 2048;

const isColor = (value: unknown): value is BackgroundColor =>
  typeof value === "string" && (BACKGROUND_COLORS as readonly string[]).includes(value);

/**
 * An image URL a background may show: a file uploaded to this server (kept as its relative path,
 * so it survives APP_URL changes and is counted as used), or an http(s) link. Null for anything else.
 */
export function backgroundImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const fileId = fileIdOf(trimmed);
  if (fileId) return fileUrl(fileId);
  if (!trimmed || trimmed.length > MAX_BACKGROUND_URL_LENGTH) return null;
  const url = URL.parse(trimmed);
  return url && (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
}

/** A stored or submitted background, checked; anything that isn't one reads as none. */
export function parsePageBackground(value: unknown): PageBackground | null {
  if (!value || typeof value !== "object") return null;
  const background = value as Record<string, unknown>;
  if (background.kind === "color") return isColor(background.color) ? { kind: "color", color: background.color } : null;
  if (background.kind === "image") {
    const url = backgroundImageUrl(background.url);
    return url ? { kind: "image", url } : null;
  }
  return null;
}

/**
 * A background written as one string, as MCP, the REST API and exports carry it: an image URL
 * (`/api/files/<id>` or a link), or `color:<name>`. Null when it is none of those.
 */
export function parseBackgroundText(value: string): PageBackground | null {
  const text = value.trim();
  if (text.startsWith("color:")) {
    const color = text.slice("color:".length);
    return isColor(color) ? { kind: "color", color } : null;
  }
  const url = backgroundImageUrl(text);
  return url ? { kind: "image", url } : null;
}

/** The background as one string (see parseBackgroundText). */
export function backgroundText(background: PageBackground): string {
  return background.kind === "color" ? `color:${background.color}` : background.url;
}

/** The uploaded file an image background shows, if it is one (the trigger in drizzle/0044 does the same). */
export function backgroundFileId(background: PageBackground | null | undefined): string | null {
  if (background?.kind !== "image") return null;
  return /^\/api\/files\/([A-Za-z0-9_-]{24})$/.exec(background.url)?.[1] ?? null;
}

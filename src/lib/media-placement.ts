/**
 * Where a block drawn as a whole sits: an image, video, audio, file, bookmark or embed may be
 * aligned (left, center or right; "left" is where the text starts, see globals.css), and a file
 * shown in place, a bookmark or an embed made narrower than its column. Pure, without editor code,
 * so published pages and print can use it (the block configs are lib/media-blocks).
 */

export type MediaAlignment = "left" | "center" | "right";

/** The alignments the media blocks offer (justify is for text). */
export const MEDIA_ALIGNMENTS: readonly MediaAlignment[] = ["left", "center", "right"];

/** The blocks that can be aligned as a whole: these, images, videos, bookmarks and embeds. */
export const ALIGNABLE_MEDIA = new Set(["image", "video", "audio", "file", "bookmark", "webEmbed"]);

/** A block's alignment as media take it: anything but center and right is the start. */
export function mediaAlignment(value: unknown): MediaAlignment {
  return value === "center" || value === "right" ? value : "left";
}

/** The narrowest a block shown in place can be made, in percent of its column. */
export const MIN_MEDIA_WIDTH = 30;

/**
 * A width as a block shown in place is drawn, in percent of its column (MIN_MEDIA_WIDTH to 99,
 * whole numbers), or null for the whole width: 0, 100 and up, and anything that isn't a number.
 */
export function mediaWidth(value: unknown): number | null {
  const width = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(width) || width <= 0 || width >= 100) return null;
  return Math.max(MIN_MEDIA_WIDTH, Math.round(width));
}

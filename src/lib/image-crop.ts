/**
 * Cropping an image block without touching its file: the part of the image to show is stored in
 * the block's `crop` prop (lib/image-links), and every place that draws the block shows only that
 * part: the editor and read-only pages (CSS in globals.css), published pages, print and HTML
 * export (inline styles from the block's HTML), PDF files (an SVG that clips the image,
 * server/pdf-document.ts). The file stays whole, so a crop can be changed or removed at any time.
 *
 * Markdown has no crop: an image is written whole, `![name](url)`, wherever it goes. A page whose
 * Markdown is written back keeps the crop of each image whose address didn't change
 * (restoreImageCrops), so an MCP edit of the text doesn't undo it.
 *
 * The prop holds JSON, `{"x":0.1,"y":0,"w":0.5,"h":0.8,"ar":1.5}`: the part's left and top edges
 * and its width and height as fractions of the image's, and the image's own width / height (its
 * aspect ratio), so the cropped shape is known before the image loads. "" is no crop.
 */

export type ImageCrop = { x: number; y: number; w: number; h: number; ar: number };

/** The smallest part of an image a crop keeps, as a fraction of each side. */
export const MIN_CROP = 0.05;

const round = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** A crop with every edge inside the image and at least MIN_CROP of each side. */
export function clampCrop(crop: ImageCrop): ImageCrop {
  const w = clamp(crop.w, MIN_CROP, 1);
  const h = clamp(crop.h, MIN_CROP, 1);
  return { x: clamp(crop.x, 0, 1 - w), y: clamp(crop.y, 0, 1 - h), w, h, ar: crop.ar };
}

/** Whether a crop keeps (nearly) the whole image, which is the same as none. */
export const isWholeImage = (crop: Pick<ImageCrop, "w" | "h">) => crop.w >= 0.999 && crop.h >= 0.999;

/** The crop a prop holds, or null for none (or anything that isn't one). */
export function parseImageCrop(value: unknown): ImageCrop | null {
  if (typeof value !== "string" || !value.trim() || value.length > 200) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h, ar } = raw as Record<string, unknown>;
  const nums = [x, y, w, h, ar];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((ar as number) <= 0.01 || (ar as number) >= 100) return null;
  const crop = clampCrop({ x: x as number, y: y as number, w: w as number, h: h as number, ar: ar as number });
  return isWholeImage(crop) ? null : crop;
}

/** The prop for a crop: "" for none or one that keeps the whole image. */
export function formatImageCrop(crop: ImageCrop | null): string {
  if (!crop) return "";
  const c = clampCrop(crop);
  if (isWholeImage(c) || !(c.ar > 0.01 && c.ar < 100)) return "";
  return JSON.stringify({ x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h), ar: round(c.ar) });
}

/** The cropped part's width / height. */
export const croppedAspect = (crop: ImageCrop) => (crop.ar * crop.w) / crop.h;

const pct = (n: number) => `${round(n * 100)}%`;

/**
 * How to draw a crop: a box of the cropped shape that hides what's outside it, and the whole
 * image inside it, scaled and moved so the part shows. As CSS properties (camel-cased for React,
 * see cropCss for an HTML attribute).
 */
export function cropStyles(crop: ImageCrop): { box: Record<string, string>; image: Record<string, string> } {
  return {
    // Rounded like an image the editor shows whole.
    box: { position: "relative", overflow: "hidden", aspectRatio: String(round(croppedAspect(crop))), borderRadius: "4px" },
    image: {
      position: "absolute",
      maxWidth: "none",
      width: pct(1 / crop.w),
      height: pct(1 / crop.h),
      left: pct(-crop.x / crop.w),
      top: pct(-crop.y / crop.h),
    },
  };
}

/** CSS properties as a `style` attribute. */
export function cropCss(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(";");
}

/**
 * An SVG showing the cropped part of an image given as a data URL (PNG or JPEG), for PDF files:
 * the whole image, its view box the part. The image is laid out 1000 units wide.
 */
export function cropSvg(crop: ImageCrop, dataUrl: string): string {
  const width = 1000;
  const height = width / crop.ar;
  const box = [crop.x * width, crop.y * height, crop.w * width, crop.h * height].map((n) => round(n));
  const href = dataUrl.replace(/[&"<>]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box[2]}" height="${box[3]}" viewBox="${box.join(" ")}">` +
    `<image x="0" y="0" width="${width}" height="${round(height)}" preserveAspectRatio="none" xlink:href="${href}"/></svg>`
  );
}

/** Where a crop handle sits: an edge or a corner ("n", "se" …), or "move" for the part itself. */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

/**
 * The crop after dragging `handle` by (dx, dy), as fractions of the image's width and height,
 * from where it was when the drag began. Edges stop at the image's and at MIN_CROP apart.
 */
export function dragCrop(start: ImageCrop, handle: CropHandle, dx: number, dy: number): ImageCrop {
  if (handle === "move") return clampCrop({ ...start, x: start.x + dx, y: start.y + dy });
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: left, y: top, w: right - left, h: bottom - top, ar: start.ar };
}

type AnyBlock = { type?: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/**
 * Markdown written back into a page brings its images back without their crop. This gives each
 * image the crop the page's image of the same address had (in order, each crop once). Changes
 * `blocks` in place.
 */
export function restoreImageCrops(blocks: AnyBlock[], existing: readonly AnyBlock[]) {
  const crops: { url: string; crop: string }[] = [];
  const collect = (list: readonly AnyBlock[]) => {
    for (const block of list) {
      const crop = block.type === "image" ? block.props?.crop : undefined;
      if (typeof crop === "string" && parseImageCrop(crop) && typeof block.props?.url === "string") crops.push({ url: block.props.url, crop });
      if (block.children?.length) collect(block.children);
    }
  };
  collect(existing);
  if (!crops.length) return;
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      if (block.type === "image" && block.props && !parseImageCrop(block.props.crop)) {
        const at = crops.findIndex((c) => c.url === block.props!.url);
        if (at >= 0) block.props.crop = crops.splice(at, 1)[0].crop;
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
}

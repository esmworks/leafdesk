/**
 * A page's background: a color that fills the page behind its title and body (a light tint in the
 * light theme and a dark one in the dark theme, or black in both; `.page-bg-*` in globals.css),
 * a pattern drawn over it (`.page-pattern-*`), or both, and a cover: a band across the top of the
 * page in one of the stylesheet's gradients (`.page-cover-*`). Kept in the `page.background`
 * column, next to the icon. Only the palette's colors, patterns and covers are taken, drawn by the
 * page's own CSS: a background or cover never loads an image, so a page can't be made to fetch
 * something from another site.
 *
 * Pure helpers only, shared by the server, the editor and the published pages.
 */
export type PageBackground = { color: BackgroundColor | null; pattern: BackgroundPattern | null; cover: PageCover | null };

/** The colors a page can take, in the order the picker shows them. */
export const BACKGROUND_COLORS = ["gray", "blue", "green", "purple", "pink", "red", "orange", "black"] as const;
export type BackgroundColor = (typeof BACKGROUND_COLORS)[number];

/** The patterns a page can take, in the order the picker shows them. */
export const BACKGROUND_PATTERNS = ["dots", "plus", "grid", "lines"] as const;
export type BackgroundPattern = (typeof BACKGROUND_PATTERNS)[number];

/** The covers a page can take, in the order the picker shows them. */
export const PAGE_COVERS = ["sunrise", "ocean", "forest", "dusk", "aurora", "sand", "mint", "slate"] as const;
export type PageCover = (typeof PAGE_COVERS)[number];

const isColor = (value: unknown): value is BackgroundColor =>
  typeof value === "string" && (BACKGROUND_COLORS as readonly string[]).includes(value);
const isPattern = (value: unknown): value is BackgroundPattern =>
  typeof value === "string" && (BACKGROUND_PATTERNS as readonly string[]).includes(value);
const isCover = (value: unknown): value is PageCover => typeof value === "string" && (PAGE_COVERS as readonly string[]).includes(value);

/** A background with this color, pattern and cover, or none when all are empty. */
export function pageBackground(color: BackgroundColor | null, pattern: BackgroundPattern | null, cover: PageCover | null = null): PageBackground | null {
  return color || pattern || cover ? { color, pattern, cover } : null;
}

/**
 * A stored or submitted background, checked; anything that isn't one reads as none. Unknown
 * colors or patterns are dropped, and an image (from an earlier build) is no background.
 */
export function parsePageBackground(value: unknown): PageBackground | null {
  if (!value || typeof value !== "object") return null;
  const background = value as Record<string, unknown>;
  if (background.kind !== undefined && background.kind !== "color") return null;
  return pageBackground(
    isColor(background.color) ? background.color : null,
    isPattern(background.pattern) ? background.pattern : null,
    isCover(background.cover) ? background.cover : null,
  );
}

/**
 * A background written as one string, as MCP and the REST API carry it: `color:<name>`,
 * `pattern:<name>` and `cover:<name>`, any of them, separated by spaces. Null when it isn't one.
 */
export function parseBackgroundText(value: string): PageBackground | null {
  let color: BackgroundColor | null = null;
  let pattern: BackgroundPattern | null = null;
  let cover: PageCover | null = null;
  for (const part of value.trim().split(/\s+/)) {
    const [key, name, ...rest] = part.split(":");
    if (rest.length > 0) return null;
    if (key === "color" && isColor(name) && !color) color = name;
    else if (key === "pattern" && isPattern(name) && !pattern) pattern = name;
    else if (key === "cover" && isCover(name) && !cover) cover = name;
    else return null;
  }
  return pageBackground(color, pattern, cover);
}

/** The background as one string (see parseBackgroundText). */
export function backgroundText(background: PageBackground): string {
  return [
    background.color && `color:${background.color}`,
    background.pattern && `pattern:${background.pattern}`,
    background.cover && `cover:${background.cover}`,
  ]
    .filter(Boolean)
    .join(" ");
}

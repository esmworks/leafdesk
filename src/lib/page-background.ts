/**
 * A page's background: a color that fills the page behind its title and body, a light tint in the
 * light theme and a dark one in the dark theme (`.page-bg-*` in globals.css). Kept in the
 * `page.background` column, next to the icon. Only the palette's colors are taken: a background
 * never loads an image, so a page can't be made to fetch something from another site.
 *
 * Pure helpers only, shared by the server, the editor and the published pages.
 */
export type PageBackground = { kind: "color"; color: BackgroundColor };

/** The colors a page can take, in the order the picker shows them. */
export const BACKGROUND_COLORS = ["gray", "blue", "green", "purple", "pink", "red", "orange"] as const;
export type BackgroundColor = (typeof BACKGROUND_COLORS)[number];

const isColor = (value: unknown): value is BackgroundColor =>
  typeof value === "string" && (BACKGROUND_COLORS as readonly string[]).includes(value);

/** A stored or submitted background, checked; anything that isn't one reads as none. */
export function parsePageBackground(value: unknown): PageBackground | null {
  if (!value || typeof value !== "object") return null;
  const background = value as Record<string, unknown>;
  return background.kind === "color" && isColor(background.color) ? { kind: "color", color: background.color } : null;
}

/** A background written as one string, as MCP and the REST API carry it: `color:<name>`. Null otherwise. */
export function parseBackgroundText(value: string): PageBackground | null {
  const text = value.trim();
  if (!text.startsWith("color:")) return null;
  const color = text.slice("color:".length);
  return isColor(color) ? { kind: "color", color } : null;
}

/** The background as one string (see parseBackgroundText). */
export function backgroundText(background: PageBackground): string {
  return `color:${background.color}`;
}

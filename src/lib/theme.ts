/** The themes someone can choose; none chosen means following the system's light or dark mode. */
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Chosen theme for this browser, read by the root layout to set <html data-theme>. */
export const THEME_COOKIE = "theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The browser bar's color in each theme: the page background (see globals.css). */
export const THEME_COLORS: Record<Theme, string> = { light: "#ffffff", dark: "#18191b" };

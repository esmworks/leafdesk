"use server";

import { cookies } from "next/headers";
import { CONTRAST_COOKIE, isContrast, isTheme, THEME_COOKIE } from "@/lib/theme";

/** Saves the theme for this browser; `null` goes back to following the system. */
export async function setThemeAction(theme: string | null) {
  if (theme !== null && !isTheme(theme)) throw new Error("Unsupported theme");
  const store = await cookies();
  if (theme === null) {
    store.delete(THEME_COOKIE);
  } else {
    store.set(THEME_COOKIE, theme, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
}

/** Saves the contrast for this browser; `null` goes back to following the system. */
export async function setContrastAction(contrast: string | null) {
  if (contrast !== null && !isContrast(contrast)) throw new Error("Unsupported contrast");
  const store = await cookies();
  if (contrast === null) {
    store.delete(CONTRAST_COOKIE);
  } else {
    store.set(CONTRAST_COOKIE, contrast, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
}

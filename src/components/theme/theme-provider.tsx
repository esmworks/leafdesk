"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useMediaQuery } from "@/components/use-media-query";
import type { Theme } from "@/lib/theme";

type ChosenTheme = { theme: Theme | null; setTheme: (theme: Theme | null) => void };

const ChosenThemeContext = createContext<ChosenTheme>({ theme: null, setTheme: () => {} });
/** A part of the app drawn in one scheme whatever the theme: a page with the black background. */
const SchemeOverride = createContext<Theme | null>(null);

/**
 * Holds the theme chosen for this browser (lib/theme.ts): the server's choice from the cookie, or
 * the one just picked in Settings, so <html data-theme> (the stylesheet) and the parts that draw
 * themselves (editor, diagrams) switch together.
 */
export function ThemeProvider({ theme: saved, children }: { theme: Theme | null; children: React.ReactNode }) {
  const [theme, setTheme] = useState(saved);
  // A refresh brings the saved choice back from the server, which may have changed in another tab.
  const [lastSaved, setLastSaved] = useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setTheme(saved);
  }
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  return <ChosenThemeContext.Provider value={{ theme, setTheme }}>{children}</ChosenThemeContext.Provider>;
}

export const useChosenTheme = () => useContext(ChosenThemeContext);

/** Draws its contents in the dark scheme when `dark`, as the stylesheet does for `.page-bg-black`. */
export function DarkScheme({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return dark ? <SchemeOverride.Provider value="dark">{children}</SchemeOverride.Provider> : children;
}

/** The scheme in effect here: a part's own, else the theme chosen, else the system's, updating when they change. */
export function useColorScheme(): Theme {
  const override = useContext(SchemeOverride);
  const { theme } = useContext(ChosenThemeContext);
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  return override ?? theme ?? (prefersDark ? "dark" : "light");
}

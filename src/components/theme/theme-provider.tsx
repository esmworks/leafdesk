"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Theme } from "@/lib/theme";

const ChosenTheme = createContext<Theme | null>(null);

/** Carries the theme chosen for this browser (lib/theme.ts) to the parts that draw themselves. */
export function ThemeProvider({ theme, children }: { theme: Theme | null; children: React.ReactNode }) {
  return <ChosenTheme.Provider value={theme}>{children}</ChosenTheme.Provider>;
}

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function usePrefersDark() {
  return useSyncExternalStore(
    (onChange) => {
      const query = darkQuery();
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => darkQuery().matches,
    () => false,
  );
}

/** The theme in effect: the one chosen, else the system's, updating when either changes. */
export function useColorScheme(): Theme {
  const chosen = useContext(ChosenTheme);
  const prefersDark = usePrefersDark();
  return chosen ?? (prefersDark ? "dark" : "light");
}

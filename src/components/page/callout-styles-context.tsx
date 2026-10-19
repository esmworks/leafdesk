"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useMemo } from "react";
import { BUILTIN_CALLOUT_STYLES, type CalloutStyle } from "@/lib/callout-styles";

/**
 * The workspace's callout styles (lib/callout-styles) for the editors under it: the workspace
 * layout provides them, so pages, row panels and synced pages draw styled callouts alike, and a
 * change in Settings reaches them when the layout is refreshed.
 */
const CalloutStylesContext = createContext<readonly CalloutStyle[]>([]);

export function CalloutStylesProvider({ styles, children }: { styles: readonly CalloutStyle[]; children: React.ReactNode }) {
  return <CalloutStylesContext.Provider value={styles}>{children}</CalloutStylesContext.Provider>;
}

export const useCalloutStyles = () => useContext(CalloutStylesContext);

/** The styles to offer: the workspace's, then the built-in ones. */
export function useOfferedCalloutStyles(): readonly CalloutStyle[] {
  const styles = useCalloutStyles();
  return useMemo(() => [...styles, ...BUILTIN_CALLOUT_STYLES], [styles]);
}

/** A style's name: the workspace's own, a built-in one's in the interface language. */
export function useCalloutStyleName() {
  const t = useTranslations("page.blocks.callout.builtin");
  return useCallback(
    (style: CalloutStyle) => (BUILTIN_CALLOUT_STYLES.some((builtin) => builtin.key === style.key) ? t(style.key as "frame") : style.name),
    [t],
  );
}

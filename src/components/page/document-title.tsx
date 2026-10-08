"use client";

import { createContext, useContext, useEffect } from "react";

/**
 * Lets a database shown as the page itself name its open view in the tab title. Set by PageView,
 * which owns `document.title`; embedded databases sit outside it or don't report.
 */
export const DocumentViewContext = createContext<((name: string | null) => void) | null>(null);

/** Reports the open view's name for the tab title while mounted; null leaves the page title alone. */
export function useDocumentViewName(name: string | null, enabled: boolean) {
  const setViewName = useContext(DocumentViewContext);
  useEffect(() => {
    if (!setViewName || !enabled) return;
    setViewName(name);
    return () => setViewName(null);
  }, [setViewName, name, enabled]);
}

"use client";

import { createContext, useContext, type ReactNode } from "react";

const LocalModeContext = createContext(false);

/**
 * Whether Leafdesk runs on one computer for one person (LEAFDESK_LOCAL_MODE, lib/env.ts), for the
 * client components that leave out what needs other people, email or a public address there.
 */
export function LocalModeProvider({ localMode, children }: { localMode: boolean; children: ReactNode }) {
  return <LocalModeContext.Provider value={localMode}>{children}</LocalModeContext.Provider>;
}

export const useLocalMode = () => useContext(LocalModeContext);

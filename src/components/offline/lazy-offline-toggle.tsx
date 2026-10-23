"use client";

import dynamic from "next/dynamic";

/**
 * "Available offline" (offline-toggle.tsx), loaded when a menu first shows it: menus are opened
 * far less often than pages are, so pages don't carry it from the start.
 */
export const LazyOfflineToggle = dynamic(() => import("./offline-toggle").then((m) => m.OfflineToggle), {
  ssr: false,
  loading: () => <div className="h-8" />,
});

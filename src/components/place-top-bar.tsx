"use client";

import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";

/**
 * The top bar of a workspace place that isn't a page (Home, My tasks, Meetings, the Calendar):
 * as tall as a page's (44 px), so the panel's head and the place's title line up with a page's,
 * with the place's name where a page has its path and the place's own controls at the end, where
 * a page has Share. It stays at the top as the place scrolls.
 */
export function PlaceTopBar({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    // Above the content's own layers as it scrolls under; the blur sits on a layer behind it, as on a page.
    <header
      data-window-controls-clear
      data-pin-sideways
      className="sticky top-0 z-[35] flex h-11 items-center justify-between gap-2 px-3 before:absolute before:inset-0 before:-z-10 before:bg-bg/90 before:backdrop-blur max-md:ps-1.5"
    >
      <div className="flex min-w-0 items-center gap-1 text-sm">
        <SidebarOpenButton className="me-1 max-md:me-0" />
        <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-fg">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-icon [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
          <span className="truncate">{title}</span>
        </span>
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </header>
  );
}

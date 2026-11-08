"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, IconButton } from "@/components/ui";
import { useChosenTheme } from "@/components/theme/theme-provider";
import { clampSidebarWidth, formatSidebarCookie, SIDEBAR_COOKIE, type SidebarLayout } from "@/lib/sidebar-layout";
import { THEME_COOKIE } from "@/lib/theme";

function saveLayout(layout: SidebarLayout) {
  document.cookie = `${SIDEBAR_COOKIE}=${formatSidebarCookie(layout)}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Phone-sized screens (below `md`) show the sidebar as a drawer over the page; wider screens show it
 * as a rail of icons and the panel beside it, which the user can collapse (the rail stays). Visibility is decided by CSS breakpoints, so the server render
 * is right on both before any script runs.
 */
type SidebarContextValue = {
  /** Desktop: the panel is hidden until reopened; the rail stays. */
  collapsed: boolean;
  /** Phones: the drawer is showing. */
  drawerOpen: boolean;
  /** Desktop, collapsed: the panel floats over the page while the pointer is on it or a rail item. */
  peek: boolean;
  /** Pointer reached a rail item or the floating panel itself. */
  showPeek: () => void;
  /** Pointer left; the peek closes after a short grace period so it can cross small gaps. */
  hidePeek: () => void;
  width: number;
  toggle: () => void;
  /** Desktop: shows the panel again where it was hidden (a rail item clicked); phones keep the drawer as it is. */
  expand: () => void;
  close: () => void;
  /** Live width while dragging; `save` persists it. */
  setWidth: (width: number, save?: boolean) => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_QUERY = "(max-width: 767px)";

export function SidebarProvider({ initial, children }: { initial: SidebarLayout; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initial.collapsed);
  const [width, setWidthState] = useState(initial.width);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  const showPeek = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
    setPeek(true);
  }, []);
  const hidePeek = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 300);
  }, []);
  useEffect(() => () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
  }, []);

  // The drawer covers the page, so following a link closes it.
  useEffect(() => setDrawerOpen(false), [pathname]);

  const toggle = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) {
      setDrawerOpen((o) => !o);
      return;
    }
    setPeek(false);
    setCollapsed((c) => {
      saveLayout({ collapsed: !c, width });
      return !c;
    });
  }, [width]);

  const expand = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) return;
    setPeek(false);
    setCollapsed(false);
    saveLayout({ collapsed: false, width });
  }, [width]);

  const setWidth = useCallback(
    (next: number, save?: boolean) => {
      const w = clampSidebarWidth(next);
      setWidthState(w);
      if (save) saveLayout({ collapsed, width: w });
    },
    [collapsed],
  );

  const { setTheme } = useChosenTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggle();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyL") {
        // Light or dark, the other one of what shows now; kept for this browser like Settings' choice.
        e.preventDefault();
        const shown = document.documentElement.dataset.theme;
        const next = (shown ? shown === "dark" : matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark";
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        setTheme(next);
      } else if (e.key === "Escape") {
        setDrawerOpen(false);
        setPeek(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, setTheme]);

  const value = useMemo<SidebarContextValue>(
    () => ({
      collapsed,
      drawerOpen,
      peek: collapsed && peek,
      showPeek,
      hidePeek,
      width,
      toggle,
      expand,
      close: () => setDrawerOpen(false),
      setWidth,
    }),
    [drawerOpen, collapsed, peek, showPeek, hidePeek, width, toggle, expand, setWidth],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  return useContext(SidebarContext);
}

/**
 * Phones: opens the sidebar's drawer. Wider screens always show the sidebar's rail, whose items
 * bring a hidden panel back, so the button isn't there.
 */
export function SidebarOpenButton({ className }: { className?: string }) {
  const t = useTranslations("sidebar.toggle");
  const sidebar = useSidebar();
  if (!sidebar) return null;
  return (
    <IconButton
      label={t("open")}
      className={cn("h-9 w-9 md:hidden", sidebar.drawerOpen && "max-md:hidden", className)}
      onClick={sidebar.toggle}
    >
      <Menu className="h-5 w-5" />
    </IconButton>
  );
}

/** Settings bring their own navigation (components/settings/settings-nav) in place of the sidebar's panel. */
export const isSettingsPath = (pathname: string) => /^\/w\/[^/]+\/settings\/?$/.test(pathname);

/** For pages without a header of their own (people, …): a floating open button. */
export function FloatingSidebarButton() {
  const pathname = usePathname();
  // Pages, the places with a top bar (components/place-top-bar.tsx), the graph, the AI chat, Mail
  // and Messages render the button in their own header; settings have their own navigation.
  if (/\/(p\/[\w-]+|graph\/?$|ai\/?$|mail\/?$|messages\/?$|tasks\/?$|meetings\/?$|calendar\/?$)/.test(pathname) || /^\/w\/[^/]+\/?$/.test(pathname) || isSettingsPath(pathname)) return null;
  return (
    <div data-window-controls-clear className="sticky top-0 z-20 h-0">
      {/* The page scrolls under it: a background of its own keeps it off the text. */}
      <SidebarOpenButton className="m-2 bg-bg" />
    </div>
  );
}

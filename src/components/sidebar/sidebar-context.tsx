"use client";

import { ChevronsRight, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, IconButton } from "@/components/ui";
import { clampSidebarWidth, formatSidebarCookie, SIDEBAR_COOKIE, type SidebarLayout } from "@/lib/sidebar-layout";

function saveLayout(layout: SidebarLayout) {
  document.cookie = `${SIDEBAR_COOKIE}=${formatSidebarCookie(layout)}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Phone-sized screens (below `md`) show the sidebar as a drawer over the page; wider screens show it
 * as a column the user can collapse. Visibility is decided by CSS breakpoints, so the server render
 * is right on both before any script runs.
 */
type SidebarContextValue = {
  /** Desktop: hidden until reopened. */
  collapsed: boolean;
  /** Phones: the drawer is showing. */
  drawerOpen: boolean;
  /** Desktop, collapsed: the sidebar floats over the page while the pointer is on it or its trigger. */
  peek: boolean;
  /** Pointer reached a peek trigger (left edge, open button) or the floating sidebar itself. */
  showPeek: () => void;
  /** Pointer left; the peek closes after a short grace period so it can cross small gaps. */
  hidePeek: () => void;
  width: number;
  toggle: () => void;
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

  const setWidth = useCallback(
    (next: number, save?: boolean) => {
      const w = clampSidebarWidth(next);
      setWidthState(w);
      if (save) saveLayout({ collapsed, width: w });
    },
    [collapsed],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape") {
        setDrawerOpen(false);
        setPeek(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo<SidebarContextValue>(
    () => ({
      collapsed,
      drawerOpen,
      peek: collapsed && peek,
      showPeek,
      hidePeek,
      width,
      toggle,
      close: () => setDrawerOpen(false),
      setWidth,
    }),
    [drawerOpen, collapsed, peek, showPeek, hidePeek, width, toggle, setWidth],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  return useContext(SidebarContext);
}

/**
 * Shown while the sidebar is hidden. Hovering it slides the sidebar out over the page (desktop);
 * clicking pins it back in place (desktop) or opens the drawer (phones).
 */
export function SidebarOpenButton({ className }: { className?: string }) {
  const t = useTranslations("sidebar.toggle");
  const sidebar = useSidebar();
  if (!sidebar) return null;
  return (
    <IconButton
      label={t("open")}
      title={`${t("open")} (⌘\\)`}
      className={cn("group/open h-7 w-7 max-md:h-9 max-md:w-9", !sidebar.collapsed && "md:hidden", sidebar.drawerOpen && "max-md:hidden", className)}
      onClick={sidebar.toggle}
      onMouseEnter={sidebar.collapsed ? sidebar.showPeek : undefined}
      onMouseLeave={sidebar.collapsed ? sidebar.hidePeek : undefined}
    >
      <Menu className="h-4 w-4 max-md:h-5 max-md:w-5 md:group-hover/open:hidden" />
      <ChevronsRight className="hidden h-4 w-4 md:group-hover/open:block" />
    </IconButton>
  );
}

/** Desktop, collapsed: an invisible strip on the left edge that slides the sidebar out. */
export function SidebarPeekEdge() {
  const sidebar = useSidebar();
  if (!sidebar?.collapsed) return null;
  return (
    <div
      aria-hidden
      className="fixed inset-y-0 left-0 z-40 hidden w-2 md:block"
      onMouseEnter={sidebar.showPeek}
      onMouseLeave={sidebar.hidePeek}
    />
  );
}

/** Settings bring their own navigation (components/settings/settings-nav) in place of the sidebar. */
export const isSettingsPath = (pathname: string) => /^\/w\/[^/]+\/settings\/?$/.test(pathname);

/** For pages without a header of their own (home, people): a floating open button. */
export function FloatingSidebarButton() {
  const pathname = usePathname();
  // Pages, the graph and the AI chat render the button in their own header; settings have no sidebar to open.
  if (/\/(p\/[\w-]+|graph\/?$|ai\/?$)/.test(pathname) || isSettingsPath(pathname)) return null;
  return (
    <div className="sticky top-0 z-20 h-0">
      <SidebarOpenButton className="m-2" />
    </div>
  );
}

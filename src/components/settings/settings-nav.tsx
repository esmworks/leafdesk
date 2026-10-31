import { ArrowLeft, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SettingsNavScroller } from "./settings-nav-scroller";

export type SettingsNavItem = { href: string; label: string; icon: LucideIcon; active?: boolean };
export type SettingsNavGroup = { label: string; items: SettingsNavItem[] };

/**
 * The settings' own navigation, in place of the workspace sidebar: a way back, then the groups
 * (the person's account, the workspace). Desktop: a column with the sidebar's look. Phones: the
 * way back on top and every item in one row that scrolls sideways. On desktop only the groups
 * scroll, so the way back and the search stay below the desktop app's window buttons.
 */
export function SettingsNav({
  label,
  back,
  search,
  groups,
}: {
  label: string;
  back: { href: string; label: string };
  /** A search over the settings (settings-search.tsx), under the way back. */
  search?: ReactNode;
  groups: SettingsNavGroup[];
}) {
  return (
    <nav
      aria-label={label}
      // Takes the sidebar's place, so the desktop app keeps its window buttons clear of it the same way (globals.css).
      data-sidebar
      data-sidebar-open
      className="shrink-0 border-b border-border bg-bg-subtle p-2 text-sm md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:flex-col md:border-e md:border-b-0"
    >
      <Link
        href={back.href}
        className="flex h-8 items-center gap-2 rounded-md px-2 text-fg hover:bg-bg-hover"
      >
        <ArrowLeft className="h-4 w-4 shrink-0 text-fg-icon rtl:-scale-x-100" aria-hidden />
        <span className="truncate">{back.label}</span>
      </Link>
      {search}
      <SettingsNavScroller className="relative mt-1 flex gap-1 overflow-x-auto [scrollbar-width:none] md:-mx-2 md:-mb-2 md:mt-4 md:min-h-0 md:flex-1 md:flex-col md:gap-5 md:overflow-x-hidden md:overflow-y-auto md:px-2 md:pb-2">
        {groups.map((group) => (
          <div key={group.label} className="contents md:block">
            <div className="px-2 pb-1 text-xs font-medium text-fg-muted max-md:hidden">{group.label}</div>
            <ul className="contents md:flex md:flex-col md:gap-px">
              {group.items.map(({ href, label: itemLabel, icon: Icon, active }) => (
                <li key={href} className="shrink-0">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-8 items-center gap-2 rounded-md px-2 whitespace-nowrap md:h-7 ${
                      active ? "bg-bg-active font-medium text-fg" : "text-fg hover:bg-bg-hover"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />
                    {itemLabel}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </SettingsNavScroller>
    </nav>
  );
}

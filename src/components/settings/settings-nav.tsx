import { ArrowLeft, ChevronRight, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type SettingsNavItem = { href: string; label: string; icon: LucideIcon; active?: boolean };
export type SettingsNavGroup = { label: string; items: SettingsNavItem[] };

/**
 * The settings' own navigation, in place of the workspace sidebar: a way back, then the groups
 * (the person's account, the workspace). Desktop: a column with the sidebar's look; only the groups
 * scroll, so the way back and the search stay below the desktop app's window buttons. Phones: one
 * screen at a time, the way a phone's own settings go. With no item picked (`list`) the nav is the
 * whole page, every item in grouped rows; with one open it is only a way back to that list.
 */
export function SettingsNav({
  label,
  back,
  search,
  groups,
  list,
}: {
  label: string;
  back: { href: string; label: string };
  /** A search over the settings (settings-search.tsx), under the way back. */
  search?: ReactNode;
  groups: SettingsNavGroup[];
  /** Phones: show every item (`open` false, the page then hides the content), or a way back to them. */
  list: { href: string; open: boolean };
}) {
  return (
    <nav
      aria-label={label}
      // Takes the sidebar's place, so the desktop app keeps its window buttons clear of it the same way (globals.css).
      data-sidebar
      data-sidebar-open
      className={`shrink-0 text-sm md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:flex-col md:border-e md:border-border md:bg-bg-subtle md:p-2 ${
        list.open ? "border-b border-border px-2 py-1 md:py-2" : "px-4 pt-3 pb-8"
      }`}
    >
      {list.open && (
        <Link href={list.href} className="flex h-10 items-center gap-2 rounded-md px-2 text-fg md:hidden">
          <ArrowLeft className="h-4 w-4 shrink-0 text-fg-icon rtl:-scale-x-100" aria-hidden />
          <span className="truncate">{label}</span>
        </Link>
      )}
      <div className={list.open ? "max-md:hidden md:contents" : "md:contents"}>
        <Link
          href={back.href}
          className="flex h-10 items-center gap-2 rounded-md px-2 text-fg hover:bg-bg-hover max-md:-mx-2 md:h-8"
        >
          <ArrowLeft className="h-4 w-4 shrink-0 text-fg-icon rtl:-scale-x-100" aria-hidden />
          <span className="truncate">{back.label}</span>
        </Link>
        <h1 className="mt-3 mb-1 text-2xl font-semibold text-fg md:hidden">{label}</h1>
        {search}
        <div className="flex flex-col gap-6 max-md:mt-5 md:-mx-2 md:-mb-2 md:mt-4 md:min-h-0 md:flex-1 md:gap-5 md:overflow-y-auto md:px-2 md:pb-2">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pb-1 text-xs font-medium text-fg-muted max-md:px-1 max-md:pb-2">{group.label}</div>
              <ul className="flex flex-col divide-border max-md:divide-y max-md:overflow-hidden max-md:rounded-lg max-md:border max-md:border-border md:gap-px">
                {group.items.map(({ href, label: itemLabel, icon: Icon, active }) => (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`flex h-11 items-center gap-3 px-3 text-fg max-md:text-base max-md:active:bg-bg-hover md:h-7 md:gap-2 md:rounded-md md:px-2 ${
                        active ? "md:bg-bg-active md:font-medium" : "md:hover:bg-bg-hover"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-fg-faint md:hidden rtl:-scale-x-100" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

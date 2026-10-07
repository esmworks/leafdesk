"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { getSidebarAction } from "@/app/actions/pages";
import { Input, PageIcon, pageLabel } from "@/components/ui";
import { searchFold } from "@/lib/search-fold";
import type { TreeNode } from "@/server/pages";

export type PickablePage = Pick<TreeNode, "id" | "title" | "icon" | "kind"> & { place: string };

/**
 * The pages and databases of the workspace the person may share, from the sidebar's tree: sharing
 * a page with an agent takes full access to it, as with anyone. Null while loading.
 */
export function useShareablePages(workspaceId: string): PickablePage[] | null {
  const t = useTranslations("page.move");
  const [pages, setPages] = useState<PickablePage[] | null>(null);
  useEffect(() => {
    let live = true;
    getSidebarAction(workspaceId)
      .then(({ tree, teamspaces }) => {
        if (!live) return;
        const spaces = new Map(teamspaces.map((ts) => [ts.id, ts.name]));
        setPages(
          tree
            .filter((n) => n.level === "full")
            .map((n) => ({
              id: n.id,
              title: n.title,
              icon: n.icon,
              kind: n.kind,
              place: n.teamspaceId ? (spaces.get(n.teamspaceId) ?? "") : t("private"),
            })),
        );
      })
      .catch(() => live && setPages([]));
    return () => {
      live = false;
    };
  }, [workspaceId, t]);
  return pages;
}

/**
 * A search box over `pages` and the matches under it (as in the move dialog): a click picks a
 * page, or with `selected` ticks it on or off.
 */
export function PagePicker({
  pages,
  label,
  empty,
  selected,
  onPick,
  autoFocus,
}: {
  pages: PickablePage[] | null;
  label: string;
  /** Shown when there is nothing to pick at all. */
  empty: string;
  /** Ticked pages, for picking several. */
  selected?: string[];
  onPick: (page: PickablePage) => void;
  autoFocus?: boolean;
}) {
  const t = useTranslations("settings.agents.access");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = searchFold(query.trim());
    return (pages ?? []).filter((p) => !q || searchFold(pageLabel(p.title, tc("untitled"))).includes(q)).slice(0, 50);
  }, [pages, query, tc]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
        <Input
          type="search"
          autoFocus={autoFocus}
          aria-label={label}
          placeholder={label}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-7"
        />
      </div>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {!pages ? (
          <li className="px-3 py-3 text-center text-sm text-fg-muted">{tc("loading")}</li>
        ) : !pages.length ? (
          <li className="px-3 py-3 text-center text-sm text-fg-muted">{empty}</li>
        ) : !shown.length ? (
          <li className="px-3 py-3 text-center text-sm text-fg-muted">{t("noMatches")}</li>
        ) : (
          shown.map((p) => {
            const title = pageLabel(p.title, tc("untitled"));
            const inner = (
              <>
                <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="max-w-[40%] shrink-0 truncate text-xs text-fg-faint">{p.place}</span>
              </>
            );
            return (
              <li key={p.id}>
                {selected ? (
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-bg-hover">
                    <input
                      type="checkbox"
                      aria-label={title}
                      checked={selected.includes(p.id)}
                      onChange={() => onPick(p)}
                      className="accent-accent"
                    />
                    {inner}
                  </label>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPick(p)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover"
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

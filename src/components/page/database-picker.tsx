"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { listDatabasesAction } from "@/app/actions/databases";
import { cn, Dialog, PageIcon, pageLabel } from "@/components/ui";
import { searchFold } from "@/lib/search-fold";

/**
 * Picks a database of the workspace the user can see: what a new linked view or dashboard widget
 * shows.
 */
export function DatabasePicker({
  open,
  workspaceId,
  onPick,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onPick: (databaseId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.embed.picker");
  const tc = useTranslations("common");
  const [databases, setDatabases] = useState<{ id: string; title: string; icon: string | null }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFailed(false);
    setDatabases(null);
    listDatabasesAction(workspaceId)
      .then((res) => {
        if (res.ok) setDatabases(res.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [open, workspaceId]);

  const matches = useMemo(() => {
    const q = searchFold(query.trim());
    return (databases ?? [])
      .filter((d) => !q || searchFold(pageLabel(d.title, tc("untitled"))).includes(q))
      .slice(0, 50);
  }, [databases, query, tc]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-fg-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          aria-label={t("title")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className={cn("max-h-80 overflow-y-auto p-1", !databases && !failed && "opacity-70")}>
        {matches.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
          >
            <PageIcon icon={d.icon} kind="database" className="text-sm" />
            <span className="truncate">{pageLabel(d.title, tc("untitled"))}</span>
          </button>
        ))}
        {failed && (
          <p role="alert" className="px-2 py-3 text-sm text-danger">
            {t("failed")}
          </p>
        )}
        {!databases && !failed && <p className="px-2 py-3 text-sm text-fg-muted">{tc("loading")}</p>}
        {databases && !matches.length && <p className="px-2 py-3 text-sm text-fg-muted">{t("empty")}</p>}
      </div>
    </Dialog>
  );
}

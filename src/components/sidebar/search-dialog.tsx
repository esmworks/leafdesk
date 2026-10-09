"use client";

import { ChevronRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { recentSearchAction, searchAction } from "@/app/actions/pages";
import { cn, Dialog, PageIcon, pageLabel } from "@/components/ui";
import type { PageKind } from "@/db/schema";
import type { SearchHit } from "@/server/pages";

/** Something the search box can do instead of opening a page: typed after `>`. */
export type SearchCommand = { id: string; label: string; icon: ReactNode; run: () => void };

type PageItem = { id: string; title: string; icon: string | null; kind: PageKind; snippet?: string; match?: SearchHit["match"] };
type Item = { type: "page"; page: PageItem } | { type: "command"; command: SearchCommand };

/** In the UI language, so a Turkish "İ" folds to "i" (not "i" with a combining dot). */
const fold = (value: string, locale: string) => value.normalize("NFC").toLocaleLowerCase(locale).trim();

/**
 * The search box (Cmd/Ctrl+K): pages by their title and content, narrowed with `in:` and `type:`
 * (see lib/search-query); the pages last edited before anything is typed; and, after `>`, the
 * commands the sidebar hands it.
 */
export function SearchDialog({
  workspaceId,
  open,
  onClose,
  commands = [],
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  commands?: SearchCommand[];
}) {
  const router = useRouter();
  const t = useTranslations("sidebar.search");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<PageItem[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const trimmed = query.trim();
  const commandMode = trimmed.startsWith(">");

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setActive(0);
      return;
    }
    let live = true;
    recentSearchAction(workspaceId).then(
      (pages) => live && setRecent(pages),
      () => live && setRecent([]),
    );
    return () => {
      live = false;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    // Bumped even when cleared, so a request still in flight can't fill the empty box.
    const id = ++requestId.current;
    setActive(0);
    if (!trimmed || commandMode) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      const result = await searchAction(workspaceId, trimmed).catch(() => []);
      if (id !== requestId.current) return; // a newer query is in flight
      setHits(result);
      setActive(0);
      setLoading(false);
    }, 150);
    return () => clearTimeout(timer);
  }, [trimmed, commandMode, workspaceId]);

  const items = useMemo<Item[]>(() => {
    if (commandMode) {
      const wanted = fold(trimmed.slice(1), locale);
      return commands.filter((c) => fold(c.label, locale).includes(wanted)).map((command) => ({ type: "command", command }));
    }
    const pages: PageItem[] = trimmed ? hits : recent;
    return pages.map((page) => ({ type: "page", page }));
  }, [commandMode, trimmed, commands, hits, recent, locale]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: Item | undefined) {
    if (!item) return;
    onClose();
    if (item.type === "command") item.command.run();
    else router.push(`/w/${workspaceId}/p/${item.page.id}`);
  }

  /** Puts a filter (or `>`) into the query from the hint line. */
  function insert(token: string) {
    setQuery((q) => (token === ">" ? `>${q.replace(/^\s*>?/, "")}` : `${q.trimEnd()}${q.trim() ? " " : ""}${token}`));
    input.current?.focus();
  }

  const heading = commandMode ? t("commands") : trimmed ? null : recent.length ? t("recent") : null;
  const empty = (commandMode || (trimmed && !loading)) && items.length === 0;

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="flex items-center gap-2 border-b border-border px-4">
        {commandMode ? <ChevronRight className="h-4 w-4 text-fg-muted" /> : <Search className="h-4 w-4 text-fg-muted" />}
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.max(0, Math.min(a + 1, items.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(items[active]);
            }
          }}
          placeholder={t("placeholder")}
          aria-label={t("label")}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="search-results"
          aria-activedescendant={items[active] ? `search-item-${active}` : undefined}
          className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-fg-faint sm:text-sm"
        />
      </div>
      <ul ref={list} id="search-results" role="listbox" aria-label={t("label")} className="max-h-[50vh] overflow-y-auto p-1">
        {heading && (
          <li role="presentation" className="px-3 pt-2 pb-1 text-xs font-medium text-fg-muted">
            {heading}
          </li>
        )}
        {empty && <li role="presentation" className="px-3 py-6 text-center text-sm text-fg-muted">{commandMode ? t("noCommands") : t("noResults")}</li>}
        {items.map((item, i) => (
          <li key={item.type === "page" ? item.page.id : item.command.id} id={`search-item-${i}`} role="option" aria-selected={i === active}>
            <button
              type="button"
              data-index={i}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
              className={cn("flex w-full items-start gap-2 rounded-md px-3 py-2 text-left", i === active && "bg-bg-hover")}
            >
              {item.type === "command" ? (
                <>
                  <span className="mt-0.5 text-fg-muted">{item.command.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{item.command.label}</span>
                </>
              ) : (
                <>
                  <PageIcon icon={item.page.icon} kind={item.page.kind} className="mt-0.5 text-sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{pageLabel(item.page.title, tc("untitled"))}</span>
                      {/* Semantic search found it by meaning; its words may not appear in the snippet. */}
                      {item.page.match === "semantic" && (
                        <span className="shrink-0 text-xs text-fg-faint" title={t("semanticHint")}>
                          {t("semantic")}
                        </span>
                      )}
                    </span>
                    {item.page.snippet && <span className="line-clamp-2 text-xs text-fg-muted">{item.page.snippet}</span>}
                  </span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-xs text-fg-muted">
        <HintButton onClick={() => insert('in:"')} token='in:"…"' label={t("hint.in")} />
        <HintButton onClick={() => insert("type:database")} token="type:database" label={t("hint.type")} />
        {commands.length > 0 && <HintButton onClick={() => insert(">")} token=">" label={t("hint.commands")} />}
      </div>
    </Dialog>
  );
}

function HintButton({ token, label, onClick }: { token: string; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
      <span className="font-medium text-fg">{token}</span> {label}
    </button>
  );
}

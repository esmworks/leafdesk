"use client";

import { Archive, BadgeCheck, ChevronRight, Hash, Paperclip, Search } from "lucide-react";
import { lazyPart } from "@/components/lazy-part";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openBlockLink } from "@/components/page/block-focus";
import { cn, Dialog, PageIcon, pageLabel, Switch } from "@/components/ui";
import type { PageKind } from "@/db/schema";
import { pageOrBlockPath } from "@/lib/mentions";
import { searchFold } from "@/lib/search-fold";
import { highlightParts } from "@/lib/search-highlight";
import { hasFilterValues, NO_SEARCH_FILTERS, type SearchFilters, type SearchSort } from "@/lib/search-filter-state";
import { parseSearchQuery } from "@/lib/search-query";
import { tagKey, typedTag } from "@/lib/tags";
import type { TagSuggestion } from "@/server/page-tags";
import type { SearchHit } from "@/server/pages";
import { read, readWith } from "@/components/read";

// Loaded with the box, not with the sidebar: the sidebar is in every page's first load.
const SearchFilterBar = lazyPart(() => import("./search-filter-bar").then((m) => m.SearchFilterBar), <div className="h-[45px] border-b border-border" />);

/**
 * Something the search box can do instead of opening a page: typed after `>`. `keywords`: other
 * words it is found by. `whenTyped`: listed only once something is typed after `>` (the settings,
 * which would otherwise bury the rest).
 */
export type SearchCommand = { id: string; label: string; icon: ReactNode; run: () => void; keywords?: string; whenTyped?: boolean };

/**
 * `blockId`: where the passage a search by meaning matched starts; the page opens there. `file`: the
 * document whose words matched, when not the page's own.
 */
type PageItem = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  snippet?: string;
  match?: SearchHit["match"];
  blockId?: string | null;
  file?: SearchHit["file"];
  /** Archived (server/page-outdated): found only while the search includes archived pages. */
  outdated?: boolean;
  /** Verified right now (server/verification): marked, and ranked above an otherwise equal page. */
  verified?: boolean;
};
type Item = { type: "page"; page: PageItem } | { type: "command"; command: SearchCommand } | { type: "tag"; tag: TagSuggestion };

/** Compared as pickers compare: case and the Turkish dotted and dotless i aside (lib/search-fold). */
const fold = (value: string) => searchFold(value.normalize("NFC").trim());

/**
 * The search box (Cmd/Ctrl+K): pages by their title and content, narrowed with `in:`, `type:`,
 * `is:verified` and `#tags` (see lib/search-query) and with the filter menus under the query (teamspace,
 * people, date: lib/search-filters), text in "quotes" found as written; before anything is typed
 * or chosen, the pages the person opened last (the pages last edited while their views aren't
 * recorded); and, after `>`, the commands the sidebar hands it. Archived pages are found only with
 * "Include archived" on, and say so. While a `#tag` is typed at the end of the query, the tags of
 * pages the person can open that start so come first, to complete it. `initialQuery`: what it
 * opens with (a tag clicked in a page).
 */
export function SearchDialog({
  workspaceId,
  open,
  initialQuery = "",
  onClose,
  commands = [],
}: {
  workspaceId: string;
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
  commands?: SearchCommand[];
}) {
  const router = useRouter();
  const t = useTranslations("sidebar.search");
  const tc = useTranslations("common");
  const tj = useTranslations("journal");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<{ source: "viewed" | "edited"; pages: PageItem[] }>({ source: "edited", pages: [] });
  const [filters, setFilters] = useState<SearchFilters>(NO_SEARCH_FILTERS);
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [includeOutdated, setIncludeOutdated] = useState(false);
  // Tags offered for the `#tag` being typed, as last loaded.
  const [tagHits, setTagHits] = useState<TagSuggestion[]>([]);
  const requestId = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const trimmed = query.trim();
  const commandMode = trimmed.startsWith(">");
  const filtered = hasFilterValues(filters);
  // The words typed and the quoted phrases, marked in the results' snippets (filters aside).
  const words = useMemo(() => {
    if (commandMode) return [];
    const parsed = parseSearchQuery(trimmed);
    return [...parsed.phrases, ...parsed.text.split(/\s+/), ...parsed.tags.map((tag) => `#${tag}`)];
  }, [trimmed, commandMode]);
  // The `#tag` being typed at the end of the query (a space after it ends it).
  const typing = commandMode ? null : typedTag(query);
  const tagQuery = typing?.query ?? null;
  const tags = useMemo(() => {
    if (tagQuery === null) return [];
    const wanted = tagKey(tagQuery);
    return tagHits.filter((tag) => tag.key.startsWith(wanted));
  }, [tagQuery, tagHits]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setActive(0);
      setFilters(NO_SEARCH_FILTERS);
      setSort("relevance");
      setTagHits([]);
      return;
    }
    if (initialQuery) setQuery(initialQuery);
    let live = true;
    read("recentSearch", workspaceId).then(
      (found) => live && setRecent(found),
      () => live && setRecent({ source: "edited", pages: [] }),
    );
    return () => {
      live = false;
    };
  }, [open, workspaceId, initialQuery]);

  useEffect(() => {
    if (tagQuery === null) return;
    let live = true;
    const timer = setTimeout(() => {
      read("tagSuggestions", workspaceId, tagQuery).then(
        (found) => live && setTagHits(found),
        () => {},
      );
    }, 100);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tagQuery, workspaceId]);

  useEffect(() => {
    // Bumped even when cleared, so a request still in flight can't fill the empty box.
    const id = ++requestId.current;
    setActive(0);
    if (commandMode || (!trimmed && !filtered)) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // A newer query cancels this one's request: searches no longer wait in line behind each other.
    const stale = new AbortController();
    const timer = setTimeout(async () => {
      const result = await readWith(stale.signal, "search", workspaceId, trimmed, includeOutdated, filtered ? filters : undefined, sort).catch(() => []);
      if (id !== requestId.current) return; // a newer query is in flight
      setHits(result);
      setActive(0);
      setLoading(false);
    }, 150);
    return () => {
      clearTimeout(timer);
      stale.abort();
    };
  }, [trimmed, commandMode, workspaceId, includeOutdated, filters, filtered, sort]);

  const items = useMemo<Item[]>(() => {
    if (commandMode) {
      const words = fold(trimmed.slice(1)).split(/\s+/).filter(Boolean);
      return commands
        .filter((c) => (words.length > 0 || !c.whenTyped) && words.every((word) => fold(`${c.label} ${c.keywords ?? ""}`).includes(word)))
        .map((command) => ({ type: "command", command }));
    }
    const pages: PageItem[] = trimmed || filtered ? hits : recent.pages;
    return [...tags.map((tag): Item => ({ type: "tag", tag })), ...pages.map((page): Item => ({ type: "page", page }))];
  }, [commandMode, trimmed, filtered, commands, hits, recent, tags]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.type === "tag") {
      // Completes the tag being typed; the box stays open with the pages carrying it.
      if (typing) setQuery(`${query.slice(0, typing.start)}#${item.tag.label} `);
      input.current?.focus();
      return;
    }
    onClose();
    if (item.type === "command") item.command.run();
    else openBlockLink(pageOrBlockPath(workspaceId, item.page.id, item.page.blockId), router.push);
  }

  /** Puts a filter (or `>`) into the query from the hint line. */
  function insert(token: string) {
    setQuery((q) => (token === ">" ? `>${q.replace(/^\s*>?/, "")}` : `${q.trimEnd()}${q.trim() ? " " : ""}${token}`));
    input.current?.focus();
  }

  const heading =
    commandMode ? t("commands") : trimmed || filtered ? null : recent.pages.length ? t(recent.source === "viewed" ? "recentViewed" : "recent") : null;
  const empty = (commandMode || ((trimmed || filtered) && !loading)) && items.length === 0;

  return (
    // Not clipped: the filter menus may reach past the box while it lists little.
    <Dialog open={open} onClose={onClose} className="overflow-visible">
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
      {!commandMode && <SearchFilterBar workspaceId={workspaceId} filters={filters} onChange={setFilters} sort={sort} onSortChange={setSort} />}
      <ul ref={list} id="search-results" role="listbox" aria-label={t("label")} className="max-h-[50vh] overflow-y-auto p-1">
        {heading && (
          <li role="presentation" className="px-3 pt-2 pb-1 text-xs font-medium text-fg-muted">
            {heading}
          </li>
        )}
        {empty && <li role="presentation" className="px-3 py-6 text-center text-sm text-fg-muted">{commandMode ? t("noCommands") : t("noResults")}</li>}
        {tags.length > 0 && (
          <li role="presentation" className="px-3 pt-2 pb-1 text-xs font-medium text-fg-muted">
            {t("tags")}
          </li>
        )}
        {items.map((item, i) => (
          <li
            key={item.type === "page" ? item.page.id : item.type === "tag" ? `#${item.tag.key}` : item.command.id}
            id={`search-item-${i}`}
            role="option"
            aria-selected={i === active}
          >
            <button
              type="button"
              data-index={i}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
              className={cn("flex w-full items-start gap-2 rounded-md px-3 py-2 text-start", i === active && "bg-bg-hover")}
            >
              {item.type === "command" ? (
                <>
                  <span className="mt-0.5 text-fg-muted">{item.command.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{item.command.label}</span>
                </>
              ) : item.type === "tag" ? (
                <>
                  <Hash className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.tag.label}</span>
                  <span className="shrink-0 text-xs text-fg-muted">{t("tagPages", { count: item.tag.pages })}</span>
                </>
              ) : (
                <>
                  <PageIcon icon={item.page.icon} kind={item.page.kind} className="mt-0.5 text-sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{pageLabel(item.page.title, tc("untitled"))}</span>
                      {item.page.verified && (
                        <span className="flex shrink-0 items-center gap-1 self-center text-xs text-fg-muted" title={t("verifiedHint")}>
                          <BadgeCheck className="h-3 w-3" aria-hidden />
                          {t("verified")}
                        </span>
                      )}
                      {item.page.outdated && (
                        <span className="flex shrink-0 items-center gap-1 self-center text-xs text-fg-faint">
                          <Archive className="h-3 w-3" aria-hidden />
                          {t("archived")}
                        </span>
                      )}
                      {/* Semantic search found it by meaning; its words may not appear in the snippet. */}
                      {item.page.match === "semantic" && (
                        <span className="shrink-0 text-xs text-fg-faint" title={t("semanticHint")}>
                          {t("semantic")}
                        </span>
                      )}
                    </span>
                    {/* Found by the words of a document the page shows: its name, then the text around them. */}
                    {item.page.file && (
                      <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted" title={t("inDocument", { name: item.page.file.name })}>
                        <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">{item.page.file.name}</span>
                      </span>
                    )}
                    {item.page.snippet && (
                      <span className="line-clamp-2 text-xs text-fg-muted">
                        {highlightParts(item.page.snippet, words).map((part, i) =>
                          part.match ? (
                            <mark key={i} className="bg-transparent font-semibold text-fg">
                              {part.text}
                            </mark>
                          ) : (
                            part.text
                          ),
                        )}
                      </span>
                    )}
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
        <HintButton onClick={() => insert("type:journal")} token="type:journal" label={tj("searchHint")} />
        <HintButton onClick={() => insert('"')} token='"…"' label={t("hint.phrase")} />
        <HintButton onClick={() => insert("#")} token="#…" label={t("hint.tag")} />
        {commands.length > 0 && <HintButton onClick={() => insert(">")} token=">" label={t("hint.commands")} />}
        <span className="ms-auto flex items-center gap-2" title={t("includeArchivedHint")}>
          <span aria-hidden>{t("includeArchived")}</span>
          <Switch
            checked={includeOutdated}
            onChange={(on) => {
              setIncludeOutdated(on);
              input.current?.focus();
            }}
            label={t("includeArchived")}
          />
        </span>
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

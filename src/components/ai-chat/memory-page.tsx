"use client";

/**
 * The Memory page: what the AI keeps for its answers, laid out like a database. Its parts are the
 * tabs (`?section=`, changed in place without a server round trip): the person's notes in this
 * workspace (their "Use memory" switch is in the settings menu) and everywhere
 * (server/account-memory.ts), only theirs; the workspace's and each teamspace's they are in
 * (server/shared-memory.ts), which those in it read and those who manage it change. Notes are
 * one-line rows grouped by kind; a row opens in a panel at the window's edge, where its line, kind
 * and details are changed in place and saved as the person leaves each field. The person's summary
 * opens there too. While the workspace has the memory off, only the notes everywhere show.
 */
import {
  AlignLeft,
  ArrowUpDown,
  Brain,
  ChevronRight,
  ChevronsRight,
  CircleDot,
  Clock,
  Copy,
  CopyPlus,
  Eye,
  ListFilter,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  changeNoteAction,
  deleteMemorySummaryAction,
  markMemorySummaryCurrentAction,
  saveMemorySummaryAction,
  setMemoryUseAction,
  writeMemorySummaryAction,
  type NoteChange,
} from "@/app/actions/ai";
import { IconGlyph } from "@/components/builtin-icon";
import { useIsOffline } from "@/components/offline/offline-context";
import { PlaceTopBar } from "@/components/place-top-bar";
import { showToast } from "@/components/toast";
import { Button, cn, IconButton, Input, MenuItem, MenuSeparator, Popover, Switch, textareaClass } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import {
  MAX_MEMORIES,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_DETAILS_CHARS,
  MAX_MEMORY_SUMMARY_CHARS,
  MEMORY_CATEGORIES,
  memoryPagePath,
  type MemoryCategory,
  type MemoryPlaceView,
  type MemorySummaryView,
  type MemoryView,
} from "@/lib/ai-chat";
import { appLogo } from "@/lib/app-logos";
import { textOn, userColor } from "@/lib/presence";
import { onOtherSidePanel, openingSidePanel } from "@/lib/side-panels";

type Note = MemoryView & { by?: string | null; byId?: string | null; byImage?: string | null };
/** `mine`, `everywhere`, `workspace` or a teamspace's id. */
type Section = string;
type Sort = "newest" | "oldest" | "name";
/**
 * What the panel shows: a note (`id` null while a new one has no line yet) or the summary. `key`
 * stays while the panel shows the same thing, so a new note keeps its fields once it is saved.
 */
type Peek = { key: number; note: { id: string | null; category: MemoryCategory } } | { key: number; summary: true };

/** Each kind's label color (globals.css `.opt-*`). */
const KIND_COLOR: Record<MemoryCategory, string> = { profile: "opt-blue", preference: "opt-purple", work: "opt-green", other: "opt-gray" };

let peeks = 0;

export function MemoryPage({
  workspaceId,
  me,
  off,
  use: initialUse,
  mine: initialMine,
  summary: initialSummary,
  account: initialAccount,
  workspace,
  teamspaces,
}: {
  workspaceId: string;
  /** The person reading, shown as the one who kept their own notes. */
  me: { id: string; name: string; image: string | null };
  /** The workspace's owners turned the memory off: only the person's notes everywhere show. */
  off: boolean;
  /** The person's own switch in this workspace. */
  use: boolean;
  mine: MemoryView[];
  /** The person's summary of their notes here (server/memory-summary.ts), if they keep one. */
  summary: MemorySummaryView | null;
  account: MemoryView[];
  /** Null for a guest. */
  workspace: MemoryPlaceView | null;
  teamspaces: MemoryPlaceView[];
}) {
  const t = useTranslations("ai.memory");
  const format = useFormatter();
  const locale = useLocale();
  const offline = useIsOffline();
  const params = useSearchParams();
  const [notes, setNotes] = useState<Record<string, Note[]>>(() => ({
    mine: initialMine,
    everywhere: initialAccount,
    ...(workspace ? { workspace: workspace.notes } : {}),
    ...Object.fromEntries(teamspaces.map((place) => [place.id!, place.notes])),
  }));
  const [use, setUse] = useState(initialUse);
  const [summary, setSummary] = useState(initialSummary);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [only, setOnly] = useState<MemoryCategory | "all">("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [closed, setClosed] = useState<ReadonlySet<MemoryCategory>>(new Set());
  const [peek, setPeek] = useState<Peek | null>(null);
  // The note whose line is changed in its row, and the right-click menu of a row.
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ note: Note; at: { x: number; y: number } } | null>(null);

  const yours: Section[] = off ? ["everywhere"] : ["mine", "everywhere"];
  const shared: MemoryPlaceView[] = off ? [] : [...(workspace ? [workspace] : []), ...teamspaces];
  const keyOf = (place: MemoryPlaceView) => place.id ?? "workspace";
  const all = [...yours, ...shared.map(keyOf)];
  const asked = params.get("section");
  const section: Section = asked && all.includes(asked) ? asked : all[0];
  const place = shared.find((p) => keyOf(p) === section) ?? null;

  const go = (next: Section) => {
    setError(null);
    setPeek(null);
    // Next follows the address: the section changes without asking the server again.
    window.history.pushState(null, "", memoryPagePath(workspaceId, next === all[0] ? undefined : next));
  };
  const label = (key: Section) => {
    if (key === "mine" || key === "everywhere") return t(`sections.${key}`);
    const found = shared.find((p) => keyOf(p) === key);
    return found?.id ? (found.name ?? "") : t("sections.workspace");
  };

  /** Changes the section's notes; returns them as they are now, or null when the change failed. */
  async function change(key: Section, edit: NoteChange): Promise<Note[] | null> {
    const layer = key === "mine" ? "person" : key === "everywhere" ? "account" : key === "workspace" ? "workspace" : "teamspace";
    setBusy(true);
    const result = await changeNoteAction(workspaceId, layer, layer === "teamspace" ? key : null, edit);
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (!result.ok) return null;
    setNotes((current) => ({ ...current, [key]: result.data.notes }));
    // The summary is written from the person's own notes: a change to them may leave it behind.
    if (result.data.summary !== undefined) setSummary(result.data.summary);
    return result.data.notes;
  }

  async function toggleUse(next: boolean) {
    setUse(next);
    setBusy(true);
    const result = await setMemoryUseAction(workspaceId, next);
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (!result.ok) setUse(!next);
  }

  const help =
    section === "mine"
      ? t("intro")
      : section === "everywhere"
        ? t("everywhereHelp")
        : place?.id
          ? t("teamspaceHelp")
          : t("workspaceHelp");
  const canChange = section === "mine" || section === "everywhere" || place?.canChange === true;
  const changes = canChange && !offline;
  const confirmAll =
    section === "mine"
      ? t("confirmForgetAll")
      : section === "everywhere"
        ? t("confirmForgetEverywhere")
        : t("confirmDeleteAll", { place: label(section) });
  const placeholder = section === "mine" ? t("addPlaceholder") : section === "everywhere" ? t("addPlaceholderEverywhere") : t("addPlaceholderShared");

  const list = notes[section] ?? [];
  const full = list.length >= MAX_MEMORIES;
  const words = query.toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  const shown = list
    .filter((note) => (only === "all" || note.category === only) && matches(note, words, locale))
    .sort((a, b) =>
      sort === "name" ? a.text.localeCompare(b.text, locale) : (sort === "newest" ? -1 : 1) * a.updatedAt.localeCompare(b.updatedAt),
    );
  const groups = MEMORY_CATEGORIES.map((category) => ({ category, notes: shown.filter((note) => note.category === category) })).filter(
    (group) => group.notes.length > 0,
  );
  const settingsShown = section === "mine" || (changes && list.length > 0);
  const openId = peek && "note" in peek ? peek.note.id : null;
  const peekNote = openId ? (list.find((note) => note.id === openId) ?? null) : null;
  const startNew = (category: MemoryCategory) => {
    setError(null);
    setPeek({ key: ++peeks, note: { id: null, category } });
  };
  const openNote = (note: Note, toggle = true) => {
    setError(null);
    setPeek(toggle && openId === note.id ? null : { key: ++peeks, note: { id: note.id, category: note.category } });
  };
  const startRename = (note: Note) => {
    renamingRef.current = note.id;
    setRenaming(note.id);
  };
  /** Saves a line changed in its row (once: Enter, then the field's blur as it goes). */
  async function rename(note: Note, text: string) {
    if (renamingRef.current !== note.id) return;
    renamingRef.current = null;
    setRenaming(null);
    if (text.trim() && text !== note.text) await change(section, { id: note.id, text });
  }
  /** Deletes a note, offering to bring it back: a new note with the same line, kind and details. */
  async function remove(note: Note) {
    const key = section;
    if (openId === note.id) setPeek(null);
    if (!(await change(key, { delete: note.id }))) return;
    showToast({
      message: t("deleted"),
      undo: async () => {
        await change(key, { add: note.text, category: note.category, ...(note.details ? { details: note.details } : {}) });
      },
    });
  }
  async function copy(note: Note) {
    try {
      await navigator.clipboard.writeText(note.details ? `${note.text}\n\n${note.details}` : note.text);
      showToast({ message: t("copied") });
    } catch {
      // The browser refused the clipboard: nothing to tell beyond it not being copied.
    }
  }

  const thisYear = new Date().getFullYear();
  const day = (iso: string) => {
    const date = new Date(iso);
    return format.dateTime(date, date.getFullYear() === thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
  };
  const longDay = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "long", timeStyle: "short" });
  /** Who kept a note: the connected app, the person who last changed a shared one, or the reader. */
  const author = (note: Note) => (note.app ? note.app : note.by ? note.by : place ? null : t("byYou"));
  /** The author's avatar, its name and what they are to the note (for the card shown on hover). */
  const authorCard = (note: Note): AuthorCardProps | null =>
    note.app
      ? { name: note.app, image: null, role: t("appAuthor"), colorKey: note.app, app: true }
      : note.by
        ? { name: note.by, image: note.byImage ?? null, role: t("personAuthor"), colorKey: note.byId ?? note.by, app: false }
        : place
          ? null
          : { name: me.name, image: me.image, role: t("youAuthor"), colorKey: me.id, app: false };

  const toolButton = (open: boolean, on = false) => cn("h-7 w-7", open && "bg-bg-active text-fg", on && "text-accent");
  const menu = (current: boolean, text: string, onPick: () => void, icon?: ReactNode) => (
    <MenuItem key={text} icon={icon} active={current} pressed={current} onClick={onPick}>
      {text}
    </MenuItem>
  );

  return (
    <>
      <PlaceTopBar icon={<Brain />} title={t("title")} />
      <div className="page-gutter pt-6 pb-16">
        <header className="mb-6">
          <h1 className="flex items-center gap-2.5 font-display text-2xl leading-tight tracking-tight md:text-3xl">
            <Brain aria-hidden className="h-7 w-7 shrink-0 text-fg-icon" strokeWidth={1.75} />
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[640px] text-sm text-fg-muted">{t("pageIntro")}</p>
          {off && <p className="mt-3 max-w-[640px] rounded-lg bg-bg-subtle px-4 py-3 text-[13px] text-fg-muted">{t("workspaceOff")}</p>}
        </header>

        <div className="relative flex flex-wrap items-end gap-x-4">
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
          <div role="tablist" aria-label={t("title")} className="relative flex min-w-0 max-w-full gap-4 overflow-x-auto [scrollbar-width:none]">
            {all.map((key) => {
              const current = key === section;
              const count = notes[key]?.length ?? 0;
              const icon = shared.find((p) => keyOf(p) === key && p.id)?.icon;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  onClick={() => go(key)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap transition-colors",
                    current ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                  )}
                >
                  {icon && <IconGlyph icon={icon} className="h-4 w-4 shrink-0 text-[15px]" />}
                  {label(key)}
                  {count > 0 && <span className="text-xs font-normal text-fg-faint tabular-nums">{count}</span>}
                </button>
              );
            })}
          </div>
          <div className="relative ms-auto flex items-center gap-0.5 pb-1.5">
            <Popover
              align="end"
              trigger={({ open, toggle }) => (
                <IconButton label={t("filterLabel")} title={t("filterLabel")} aria-expanded={open} onClick={toggle} className={toolButton(open, only !== "all")}>
                  <ListFilter className="h-4 w-4" />
                </IconButton>
              )}
            >
              {(close) => (
                <div className="w-52">
                  {menu(only === "all", t("allCategories"), () => {
                    setOnly("all");
                    close();
                  })}
                  <MenuSeparator />
                  {MEMORY_CATEGORIES.map((category) =>
                    menu(
                      only === category,
                      t(`categories.${category}`),
                      () => {
                        setOnly(category);
                        close();
                      },
                      <span className={cn(KIND_COLOR[category], "h-3 w-3 rounded-sm")} />,
                    ),
                  )}
                </div>
              )}
            </Popover>
            <Popover
              align="end"
              trigger={({ open, toggle }) => (
                <IconButton label={t("sort")} title={t("sort")} aria-expanded={open} onClick={toggle} className={toolButton(open, sort !== "newest")}>
                  <ArrowUpDown className="h-4 w-4" />
                </IconButton>
              )}
            >
              {(close) => (
                <div className="w-48">
                  {(
                    [
                      ["newest", t("newestFirst")],
                      ["oldest", t("oldestFirst")],
                      ["name", t("aToZ")],
                    ] as const
                  ).map(([key, text]) =>
                    menu(sort === key, text, () => {
                      setSort(key);
                      close();
                    }),
                  )}
                </div>
              )}
            </Popover>
            {searching || query ? (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
                <Input
                  type="search"
                  autoFocus
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => setSearching(false)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    setQuery("");
                    setSearching(false);
                  }}
                  className="h-7 w-40 ps-7 sm:w-52"
                />
              </div>
            ) : (
              <IconButton label={t("search")} title={t("search")} onClick={() => setSearching(true)} className="h-7 w-7">
                <Search className="h-4 w-4" />
              </IconButton>
            )}
            {settingsShown && (
              <Popover
                align="end"
                trigger={({ open, toggle }) => (
                  <IconButton label={t("settings")} title={t("settings")} aria-expanded={open} onClick={toggle} className={toolButton(open)}>
                    <Settings2 className="h-4 w-4" />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div className="w-72">
                    {section === "mine" && (
                      <div className="flex items-start gap-3 px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{t("use")}</p>
                          <p className="text-xs text-fg-muted">{t("useHint")}</p>
                        </div>
                        <Switch checked={use} label={t("use")} disabled={busy || offline} onChange={(next) => void toggleUse(next)} />
                      </div>
                    )}
                    {section === "mine" && changes && list.length > 0 && <MenuSeparator />}
                    {changes && list.length > 0 && (
                      <MenuItem
                        danger
                        icon={<Trash2 className="h-4 w-4" />}
                        disabled={busy}
                        onClick={() => {
                          close();
                          if (confirm(confirmAll)) void change(section, { delete: "all" });
                        }}
                      >
                        {place ? t("deleteAll") : t("forgetAll")}
                      </MenuItem>
                    )}
                  </div>
                )}
              </Popover>
            )}
            {canChange && (
              <Button variant="primary" size="sm" className="ms-1.5" disabled={!changes || full} onClick={() => startNew(only === "all" ? "other" : only)}>
                <Plus className="h-3.5 w-3.5" />
                {t("addLabel")}
              </Button>
            )}
          </div>
        </div>

        <div role="tabpanel" aria-label={label(section)} className="pt-4">
          <p className="mb-4 max-w-[640px] text-[13px] text-fg-muted">{help}</p>
          {place && !place.canChange && (
            <p className="mb-4 flex items-center gap-1.5 text-[13px] text-fg-muted">
              <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("readOnly")}
            </p>
          )}
          {error && !peek && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {error}
            </p>
          )}
          {section === "mine" && (
            <SummaryRow summary={summary} open={peek !== null && "summary" in peek} onOpen={() => setPeek(peek && "summary" in peek ? null : { key: ++peeks, summary: true })} />
          )}
          {canChange && offline && <p className="mb-3 text-[13px] text-fg-muted">{t("offline")}</p>}

          {list.length === 0 ? (
            <div className="py-6">
              <p className="text-sm text-fg-muted">{place ? t("emptyShared") : t("empty")}</p>
              {changes && <NewRow label={t("addLabel")} onClick={() => startNew("other")} />}
            </div>
          ) : groups.length === 0 ? (
            <p className="py-6 text-sm text-fg-muted">{t("noMatch")}</p>
          ) : (
            groups.map(({ category, notes: inGroup }) => {
              const open = !closed.has(category);
              return (
                <section key={category} aria-label={t(`categories.${category}`)} className="group/kind mb-4">
                  <div className="flex h-8 items-center gap-1.5">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setClosed((current) => {
                          const next = new Set(current);
                          if (open) next.add(category);
                          else next.delete(category);
                          return next;
                        })
                      }
                      className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-bg-hover"
                    >
                      <ChevronRight
                        aria-hidden
                        className={cn("h-3.5 w-3.5 text-fg-faint transition-transform", open ? "rotate-90" : "rtl:-scale-x-100")}
                      />
                      <span className={cn(KIND_COLOR[category], "rounded px-1.5 text-xs leading-5 font-medium")}>{t(`categories.${category}`)}</span>
                    </button>
                    <span className="text-xs text-fg-faint tabular-nums">{inGroup.length}</span>
                    {changes && !full && (
                      <IconButton
                        label={t("addLabel")}
                        onClick={() => startNew(category)}
                        className="h-6 w-6 opacity-0 group-hover/kind:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  </div>
                  {open && (
                    <ul>
                      {inGroup.map((note) => {
                        const by = author(note);
                        const card = authorCard(note);
                        const active = openId === note.id;
                        return (
                          <li key={note.id}>
                            <div
                              onClick={() => {
                                if (renaming !== note.id) openNote(note);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setRowMenu({ note, at: { x: e.clientX, y: e.clientY } });
                              }}
                              className={cn(
                                "group/row flex h-9 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-bg-hover",
                                active && "bg-bg-active hover:bg-bg-active",
                              )}
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                {renaming === note.id ? (
                                  <input
                                    autoFocus
                                    aria-label={t("editLabel")}
                                    defaultValue={note.text}
                                    maxLength={MAX_MEMORY_CHARS}
                                    onClick={(e) => e.stopPropagation()}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        void rename(note, e.currentTarget.value);
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        renamingRef.current = null;
                                        setRenaming(null);
                                      }
                                    }}
                                    onBlur={(e) => void rename(note, e.currentTarget.value)}
                                    className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-bg px-1.5 text-sm font-medium text-fg outline-none"
                                  />
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      aria-expanded={active}
                                      onKeyDown={(e) => {
                                        // Delete (or backspace) on a row deletes it, with an Undo to bring it back.
                                        if (!changes || (e.key !== "Delete" && e.key !== "Backspace")) return;
                                        e.preventDefault();
                                        void remove(note);
                                      }}
                                      className="min-w-0 truncate rounded-sm text-start text-sm font-medium text-fg"
                                    >
                                      {note.text}
                                    </button>
                                    {note.details && (
                                      <AlignLeft role="img" aria-label={t("detailsLabel")} className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                                    )}
                                    {changes && (
                                      <IconButton
                                        label={t("rename")}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          startRename(note);
                                        }}
                                        className="h-6 w-6 shrink-0 border border-border bg-bg opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </IconButton>
                                    )}
                                  </>
                                )}
                              </div>
                              <span className="group/author relative hidden w-36 shrink-0 items-center gap-1.5 sm:flex">
                                {by && card && (
                                  <>
                                    <Face card={card} />
                                    <span className="truncate text-sm text-fg-muted">{by}</span>
                                    <AuthorCard {...card} />
                                  </>
                                )}
                              </span>
                              <time dateTime={note.updatedAt} title={longDay(note.updatedAt)} className="w-16 shrink-0 text-end text-sm text-fg-faint tabular-nums">
                                {day(note.updatedAt)}
                              </time>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })
          )}
          {list.length > 0 && changes && !full && groups.length > 0 && (
            <NewRow label={t("addLabel")} onClick={() => startNew(only === "all" ? "other" : only)} />
          )}
          {list.length > 0 && (
            <p className="mt-2 text-xs text-fg-faint tabular-nums">
              {full ? t("full", { max: MAX_MEMORIES }) : t("count", { count: list.length, max: MAX_MEMORIES })}
            </p>
          )}
        </div>
      </div>
      <Popover trigger={() => null} open={rowMenu !== null} onOpenChange={(open) => !open && setRowMenu(null)} at={rowMenu?.at ?? null}>
        {(close) =>
          rowMenu && (
            <div className="w-60">
              <MenuItem
                icon={<PanelRight className="h-4 w-4" />}
                onClick={() => {
                  close();
                  openNote(rowMenu.note, false);
                }}
              >
                {t("openNote")}
              </MenuItem>
              {changes && (
                <MenuItem
                  icon={<Pencil className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    startRename(rowMenu.note);
                  }}
                >
                  {t("rename")}
                </MenuItem>
              )}
              <MenuItem
                icon={<Copy className="h-4 w-4" />}
                onClick={() => {
                  close();
                  void copy(rowMenu.note);
                }}
              >
                {t("copyText")}
              </MenuItem>
              {changes && !full && (
                <MenuItem
                  icon={<CopyPlus className="h-4 w-4" />}
                  disabled={busy}
                  onClick={() => {
                    close();
                    const { text, category, details } = rowMenu.note;
                    void change(section, { add: text, category, ...(details ? { details } : {}) });
                  }}
                >
                  {t("duplicate")}
                </MenuItem>
              )}
              {changes && (
                <>
                  <MenuSeparator />
                  <p className="px-2 pt-1 pb-0.5 text-xs text-fg-muted">{t("categoryLabel")}</p>
                  {MEMORY_CATEGORIES.map((c) => (
                    <MenuItem
                      key={c}
                      active={c === rowMenu.note.category}
                      pressed={c === rowMenu.note.category}
                      disabled={busy}
                      onClick={() => {
                        close();
                        if (c !== rowMenu.note.category) void change(section, { id: rowMenu.note.id, text: rowMenu.note.text, category: c });
                      }}
                    >
                      <span className={cn(KIND_COLOR[c], "rounded px-1.5 text-xs leading-5 font-medium")}>{t(`categories.${c}`)}</span>
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem
                    danger
                    icon={<Trash2 className="h-4 w-4" />}
                    disabled={busy}
                    onClick={() => {
                      close();
                      void remove(rowMenu.note);
                    }}
                  >
                    {t("delete")}
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              <div className="px-2 py-1.5 text-xs text-fg-faint">
                <p>{t("lastEdited")}</p>
                {author(rowMenu.note) && <p className="mt-0.5 text-fg-muted">{author(rowMenu.note)}</p>}
                <p className="mt-0.5 tabular-nums">{longDay(rowMenu.note.updatedAt)}</p>
              </div>
            </div>
          )
        }
      </Popover>
      {peek && "summary" in peek && (
        <PeekPanel key={peek.key} label={t("summary.title")} onClose={() => setPeek(null)}>
          <SummaryPeek workspaceId={workspaceId} summary={summary} use={use} hasNotes={(notes.mine?.length ?? 0) + (notes.everywhere?.length ?? 0) > 0} onChange={setSummary} />
        </PeekPanel>
      )}
      {peek && "note" in peek && (peek.note.id === null || peekNote) && (
        <NotePeek
          key={peek.key}
          note={peekNote}
          category={peek.note.category}
          readOnly={!changes}
          busy={busy}
          full={full}
          error={error}
          placeholder={placeholder}
          by={peekNote ? author(peekNote) : null}
          card={peekNote ? authorCard(peekNote) : null}
          when={peekNote ? longDay(peekNote.updatedAt) : null}
          onSave={async (edit) => {
            const before = new Set(list.map((note) => note.id));
            const now = await change(section, edit);
            if (!now) return null;
            if ("id" in edit) return now.find((note) => note.id === edit.id) ?? null;
            // A new note's line was saved: the panel goes on showing it as the note it now is.
            const added = now.find((note) => !before.has(note.id)) ?? null;
            if (added) setPeek((current) => (current && "note" in current && current.note.id === null ? { key: current.key, note: { id: added.id, category: added.category } } : current));
            return added;
          }}
          onDelete={async (id) => {
            const note = list.find((n) => n.id === id);
            if (note) await remove(note);
          }}
          onClose={() => {
            setError(null);
            setPeek(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Who kept a note, as its row shows them: `app` for a connected app (its logo when it is a known
 * one), else a person (their picture). `colorKey` picks the color of the initial shown without one.
 */
type AuthorCardProps = { name: string; image: string | null; role: string; colorKey: string; app: boolean };

/** The face of who kept a note: an app's logo, a person's picture, or an initial in their color. */
function Face({ card, size = "xs" }: { card: AuthorCardProps; size?: "xs" | "lg" }) {
  const logo = card.app ? appLogo(card.name) : null;
  if (logo) {
    return <img src={logo} alt="" aria-hidden className={cn("shrink-0 rounded-md bg-white object-contain", size === "xs" ? "h-5 w-5" : "h-9 w-9 rounded-lg")} />;
  }
  const color = userColor(card.colorKey);
  return (
    <UserAvatar
      name={card.name}
      image={card.app ? null : card.image}
      size={size}
      colors=""
      // An app is a rounded square, a person a circle.
      className={card.app ? (size === "xs" ? "rounded-md" : "rounded-lg") : undefined}
      style={{ background: color, color: textOn(color) }}
    />
  );
}

/**
 * Who kept a note, shown over its name while the pointer rests there (inside a `group/author`):
 * their picture, name and what they are to the note. Only for pointers; the name is beside it.
 */
function AuthorCard({ below = false, ...card }: AuthorCardProps & { below?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none invisible absolute end-0 z-30 flex w-64 items-center gap-3 rounded-lg border border-border bg-bg p-3 text-start opacity-0 shadow-lg transition-opacity group-hover/author:visible group-hover/author:opacity-100 group-hover/author:delay-300",
        below ? "top-full mt-1.5 inset-s-0 end-auto" : "bottom-full mb-1.5",
      )}
    >
      <Face card={card} size="lg" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{card.name}</span>
        <span className="block truncate text-xs text-fg-muted">{card.role}</span>
      </span>
    </span>
  );
}

/** The row under a group (or an empty list) that starts a new note. */
function NewRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-faint hover:bg-bg-hover hover:text-fg">
      <Plus className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

/** The summary's row above the notes: its first line, opening it in the panel. */
function SummaryRow({ summary, open, onOpen }: { summary: MemorySummaryView | null; open: boolean; onOpen: () => void }) {
  const t = useTranslations("ai.memory");
  const first =
    summary?.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^#{1,6} /.test(line))
      ?.replace(/^[-*] /, "") ?? null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onOpen}
      className={cn(
        "mb-6 flex h-11 w-full items-center gap-3 rounded-lg border border-border px-3 text-start hover:bg-bg-hover",
        open && "bg-bg-active hover:bg-bg-active",
      )}
    >
      <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-fg-icon" />
      <span className="shrink-0 text-sm font-medium">{t("summary.title")}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{first ?? t("summary.hint")}</span>
      {summary?.withheld ? (
        <span aria-hidden title={t("summary.withheld")} className="h-2 w-2 shrink-0 rounded-full bg-danger" />
      ) : (
        summary?.stale && <span className="hidden shrink-0 text-xs text-fg-faint sm:inline">{t("summary.stale")}</span>
      )}
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-fg-faint rtl:-scale-x-100" />
    </button>
  );
}

/**
 * The panel at the window's edge (beside the AI chat while it is open) that shows one note or the
 * summary over the page's end, as a database's row opens. Esc or the button at its top closes it;
 * another side panel opening closes it too.
 */
function PeekPanel({ label, onClose, actions, children }: { label: string; onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  const tc = useTranslations("common");
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    openingSidePanel("memory");
    return onOtherSidePanel("memory", () => close.current());
  }, []);
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
      className="fixed top-(--app-top) bottom-0 inset-e-(--chat-width) z-40 flex w-full flex-col border-s border-border bg-bg pb-(--safe-bottom) shadow-xl md:w-[min(560px,calc(100vw-var(--chat-width)-320px))]"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <IconButton label={tc("close")} title={tc("close")} onClick={onClose} className="h-7 w-7">
          <ChevronsRight className="h-4 w-4 rtl:-scale-x-100" />
        </IconButton>
        <div className="ms-auto flex items-center gap-1">{actions}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-12 md:px-12">{children}</div>
    </aside>
  );
}

/** Grows a textarea with its text, as a page's lines do. */
function useGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

/** One line of a note's properties: an icon and name, then its value. */
function Property({ icon, name, children }: { icon: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-sm">
      <span className="flex w-36 shrink-0 items-center gap-2 text-fg-muted [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0">
        {icon}
        {name}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * One note in the panel, or a new one: its line as the title, its kind, who kept it and when, and
 * its details as the body. Each field is saved as the person leaves it (a kind as it is picked); a
 * new note is kept once its line is written.
 */
function NotePeek({
  note,
  category,
  readOnly,
  busy,
  full,
  error,
  placeholder,
  by,
  card,
  when,
  onSave,
  onDelete,
  onClose,
}: {
  note: Note | null;
  category: MemoryCategory;
  readOnly: boolean;
  busy: boolean;
  full: boolean;
  error: string | null;
  placeholder: string;
  by: string | null;
  /** Who `by` is, for their avatar and the card on hover. */
  card: AuthorCardProps | null;
  when: string | null;
  /** Saves a change; resolves to the note as saved, or null when it failed. */
  onSave: (edit: NoteChange) => Promise<Note | null>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations("ai.memory");
  const [text, setText] = useState(note?.text ?? "");
  const [kind, setKind] = useState<MemoryCategory>(note?.category ?? category);
  const [details, setDetails] = useState(note?.details ?? "");
  const title = useGrow(text);
  const body = useGrow(details);
  // The fields as they are now, and the note as last saved (null until a new one's line is).
  const fields = useRef({ text, kind, details });
  const saved = useRef(note);
  useLayoutEffect(() => {
    fields.current = { text, kind, details };
    if (note) saved.current = note;
  });
  // Saves run one after another, each saving the fields as they are when it starts: what is
  // written while a new note's line is being kept is saved to it right after, never added twice.
  const queue = useRef<Promise<void>>(Promise.resolve());

  function save(next: { kind?: MemoryCategory } = {}) {
    if (readOnly) return;
    queue.current = queue.current.then(() => saveNow(next));
  }

  async function saveNow(next: { kind?: MemoryCategory }) {
    const { text: line, details: d } = fields.current;
    const k = next.kind ?? fields.current.kind;
    const base = saved.current;
    if (!line.trim()) {
      // A note keeps its line: emptied, it comes back.
      if (base) setText(base.text);
      return;
    }
    if (base) {
      if (line === base.text && k === base.category && d === (base.details ?? "")) return;
      saved.current = (await onSave({ id: base.id, text: line, category: k, details: d })) ?? base;
      return;
    }
    if (full) return;
    saved.current = await onSave({ add: line, category: k, ...(d.trim() ? { details: d } : {}) });
  }

  const closeSaving = () => {
    save();
    onClose();
  };
  const titleKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A note is one line: Enter goes on to its details.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      body.current?.focus();
    }
  };

  return (
    <PeekPanel
      label={note?.text ?? t("addLabel")}
      onClose={closeSaving}
      actions={
        note &&
        !readOnly && (
          <IconButton label={t("delete")} title={t("delete")} disabled={busy} onClick={() => void onDelete(note.id)} className="h-7 w-7 hover:text-danger">
            <Trash2 className="h-4 w-4" />
          </IconButton>
        )
      }
    >
      <textarea
        ref={title}
        autoFocus={!note && !readOnly}
        readOnly={readOnly}
        rows={1}
        aria-label={t("editLabel")}
        placeholder={placeholder}
        value={text}
        maxLength={MAX_MEMORY_CHARS}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={titleKeys}
        onBlur={() => save()}
        className="block w-full resize-none overflow-hidden bg-transparent font-display text-2xl leading-snug font-semibold tracking-tight text-fg outline-none placeholder:text-fg-faint md:text-[28px]"
      />
      <div className="mt-5 space-y-0.5">
        <Property icon={<CircleDot aria-hidden />} name={t("categoryLabel")}>
          {readOnly ? (
            <span className={cn(KIND_COLOR[kind], "rounded px-1.5 text-xs leading-5 font-medium")}>{t(`categories.${kind}`)}</span>
          ) : (
            <Popover
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={toggle}
                  className={cn("-mx-1 flex h-7 items-center rounded-md px-1 hover:bg-bg-hover", open && "bg-bg-hover")}
                >
                  <span className={cn(KIND_COLOR[kind], "rounded px-1.5 text-xs leading-5 font-medium")}>{t(`categories.${kind}`)}</span>
                </button>
              )}
            >
              {(close) => (
                <div className="w-48">
                  {MEMORY_CATEGORIES.map((c) => (
                    <MenuItem
                      key={c}
                      active={c === kind}
                      pressed={c === kind}
                      onClick={() => {
                        close();
                        setKind(c);
                        save({ kind: c });
                      }}
                    >
                      <span className={cn(KIND_COLOR[c], "rounded px-1.5 text-xs leading-5 font-medium")}>{t(`categories.${c}`)}</span>
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
          )}
        </Property>
        {by && (
          <Property icon={<UserRound aria-hidden />} name={t("keptBy")}>
            <span className="group/author relative flex min-w-0 items-center gap-1.5">
              {card && <Face card={card} />}
              <span className="truncate">{by}</span>
              {card && <AuthorCard {...card} below />}
            </span>
          </Property>
        )}
        {when && (
          <Property icon={<Clock aria-hidden />} name={t("lastEdited")}>
            <span className="truncate">{when}</span>
          </Property>
        )}
      </div>
      <div className="my-5 h-px bg-border" />
      <textarea
        ref={body}
        readOnly={readOnly}
        rows={3}
        aria-label={t("detailsLabel")}
        placeholder={readOnly ? undefined : t("detailsPlaceholder")}
        value={details}
        maxLength={MAX_MEMORY_DETAILS_CHARS}
        onChange={(e) => setDetails(e.target.value)}
        onBlur={() => save()}
        className="block w-full resize-none overflow-hidden bg-transparent text-[15px] leading-7 text-fg outline-none placeholder:text-fg-faint"
      />
      {!note && full && <p className="mt-3 text-xs text-fg-muted">{t("full", { max: MAX_MEMORIES })}</p>}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </PeekPanel>
  );
}

/** A summary as written: Markdown headings, `- ` bullets and lines, without any other Markdown (a `#tag` line is a line). */
function SummaryText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={blocks.length} className="list-disc space-y-0.5 ps-5">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^#{1,6} /.exec(line);
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="pt-3 text-sm font-semibold text-fg">
          {line.slice(heading[0].length).trim()}
        </p>,
      );
    } else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="space-y-1.5 text-[15px] leading-7 break-words">{blocks}</div>;
}

/**
 * The person's summary of their notes here, in the panel: written by the AI when they ask, or by
 * them; changed in place or deleted, asking first where that loses what they wrote; marked when
 * their notes changed since, and held back from questions when a note it was written from did
 * (until written again or marked as up to date). `use`: their memory is on here, which writing and
 * changing it needs.
 */
function SummaryPeek({
  workspaceId,
  summary,
  use,
  hasNotes,
  onChange,
}: {
  workspaceId: string;
  summary: MemorySummaryView | null;
  use: boolean;
  hasNotes: boolean;
  onChange: (summary: MemorySummaryView | null) => void;
}) {
  const t = useTranslations("ai.memory");
  const format = useFormatter();
  const offline = useIsOffline();
  const [editing, setEditing] = useState<string | null>(null);
  const [working, setWorking] = useState<"write" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "write" | "save", run: () => Promise<{ ok: true; data: MemorySummaryView | null } | { ok: false; error: string }>) {
    setWorking(kind);
    setError(null);
    const result = await run();
    setWorking(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChange(result.data);
    setEditing(null);
  }

  const busy = working !== null || offline;
  const when = summary ? format.dateTime(new Date(summary.updatedAt), { dateStyle: "medium" }) : "";
  return (
    <section aria-label={t("summary.title")}>
      <h2 className="font-display text-2xl leading-snug font-semibold tracking-tight md:text-[28px]">{t("summary.title")}</h2>
      {!summary && <p className="mt-2 text-sm text-fg-muted">{t("summary.hint")}</p>}
      {summary && editing === null && (
        <p className="mt-1 text-sm text-fg-muted">
          {summary.writtenBy === "ai" ? t("summary.byAi", { date: when }) : t("summary.byYou", { date: when })}
          {summary.stale && !summary.withheld && ` · ${t("summary.stale")}`}
        </p>
      )}
      {summary?.withheld && editing === null && <p className="mt-2 text-sm text-danger">{t("summary.withheld")}</p>}
      {editing === null && (
        <div className="mt-4 flex flex-wrap gap-1">
          {use && hasNotes && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                // What the person wrote themselves goes with it: ask first.
                if (summary?.writtenBy === "person" && !confirm(t("summary.confirmRewrite"))) return;
                void act("write", () => writeMemorySummaryAction(workspaceId));
              }}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {working === "write" ? t("summary.writing") : summary ? t("summary.rewrite") : t("summary.write")}
            </Button>
          )}
          {summary && use && (summary.stale || summary.withheld) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("save", () => markMemorySummaryCurrentAction(workspaceId))}>
              {t("summary.markCurrent")}
            </Button>
          )}
          {summary && use && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(summary.text)}>
              {t("edit")}
            </Button>
          )}
          {summary && (
            <Button
              size="sm"
              variant="ghost"
              className="hover:text-danger"
              disabled={busy}
              onClick={() => {
                if (!confirm(t("summary.confirmDelete"))) return;
                void act("save", () => deleteMemorySummaryAction(workspaceId).then((r) => (r.ok ? { ok: true as const, data: null } : r)));
              }}
            >
              {t("delete")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="my-5 h-px bg-border" />
      {editing !== null ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("save", () => saveMemorySummaryAction(workspaceId, editing));
          }}
        >
          <textarea
            autoFocus
            aria-label={t("summary.title")}
            className={cn(textareaClass, "min-h-64")}
            rows={14}
            value={editing}
            maxLength={MAX_MEMORY_SUMMARY_CHARS}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              // Esc leaves the editing, not the panel.
              if (e.key !== "Escape") return;
              e.preventDefault();
              setEditing(null);
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button size="sm" type="submit" variant="primary" disabled={busy}>
              {t("save")}
            </Button>
          </div>
        </form>
      ) : (
        summary && <SummaryText text={summary.text} />
      )}
    </section>
  );
}

/** Whether a note (its line or its details) has every word of a search, any case. */
function matches(note: Note, words: string[], locale: string): boolean {
  const text = `${note.text}\n${note.details ?? ""}`.toLocaleLowerCase(locale);
  return words.every((word) => text.includes(word));
}

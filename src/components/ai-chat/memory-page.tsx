"use client";

/**
 * The Memory page: what the AI keeps for its answers, laid out like a database. Its parts are the
 * tabs (`?section=`, changed in place without a server round trip): the person's notes in this
 * workspace (their "Use memory" switch is in the settings menu) and everywhere
 * (server/account-memory.ts), only theirs; the workspace's and each teamspace's they are in
 * (server/shared-memory.ts), which those in it read and those who manage it change. Notes are rows
 * grouped by kind, each opened in a dialog to change it. While the workspace has the memory off,
 * only the notes everywhere show.
 */
import { ArrowUpDown, Brain, ChevronRight, Eye, ListFilter, Pencil, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";
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
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  Popover,
  selectClass,
  Switch,
  textareaClass,
} from "@/components/ui";
import {
  isMemoryCategory,
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

type Note = MemoryView & { by?: string | null };
/** `mine`, `everywhere`, `workspace` or a teamspace's id. */
type Section = string;
type Sort = "newest" | "oldest" | "name";

/** Each kind's label color (globals.css `.opt-*`). */
const KIND_COLOR: Record<MemoryCategory, string> = { profile: "opt-blue", preference: "opt-purple", work: "opt-green", other: "opt-gray" };

export function MemoryPage({
  workspaceId,
  off,
  use: initialUse,
  mine: initialMine,
  summary: initialSummary,
  account: initialAccount,
  workspace,
  teamspaces,
}: {
  workspaceId: string;
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
  // The note open in the dialog, or null with the kind a new one starts as.
  const [dialog, setDialog] = useState<{ note: Note | null; category: MemoryCategory } | null>(null);

  const yours: Section[] = off ? ["everywhere"] : ["mine", "everywhere"];
  const shared: MemoryPlaceView[] = off ? [] : [...(workspace ? [workspace] : []), ...teamspaces];
  const keyOf = (place: MemoryPlaceView) => place.id ?? "workspace";
  const all = [...yours, ...shared.map(keyOf)];
  const asked = params.get("section");
  const section: Section = asked && all.includes(asked) ? asked : all[0];
  const place = shared.find((p) => keyOf(p) === section) ?? null;

  const go = (next: Section) => {
    setError(null);
    // Next follows the address: the section changes without asking the server again.
    window.history.pushState(null, "", memoryPagePath(workspaceId, next === all[0] ? undefined : next));
  };
  const label = (key: Section) => {
    if (key === "mine" || key === "everywhere") return t(`sections.${key}`);
    const found = shared.find((p) => keyOf(p) === key);
    return found?.id ? (found.name ?? "") : t("sections.workspace");
  };

  async function change(key: Section, edit: NoteChange) {
    const layer = key === "mine" ? "person" : key === "everywhere" ? "account" : key === "workspace" ? "workspace" : "teamspace";
    setBusy(true);
    const result = await changeNoteAction(workspaceId, layer, layer === "teamspace" ? key : null, edit);
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (result.ok) {
      setNotes((current) => ({ ...current, [key]: result.data.notes }));
      // The summary is written from the person's own notes: a change to them may leave it behind.
      if (result.data.summary !== undefined) setSummary(result.data.summary);
    }
    return result.ok;
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
  const startNew = (category: MemoryCategory) => {
    setError(null);
    setDialog({ note: null, category });
  };

  const thisYear = new Date().getFullYear();
  const day = (iso: string) => {
    const date = new Date(iso);
    return format.dateTime(date, date.getFullYear() === thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
  };
  /** Who kept a note: the connected app, the person who last changed a shared one, or the reader. */
  const author = (note: Note) => (note.app ? note.app : note.by ? note.by : place ? null : t("byYou"));
  const authorTitle = (note: Note) => (note.app ? t("viaApp", { app: note.app }) : note.by ? t("byPerson", { name: note.by }) : undefined);

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
          {error && !dialog && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {error}
            </p>
          )}
          {section === "mine" && (
            <SummaryBox
              workspaceId={workspaceId}
              summary={summary}
              use={use}
              hasNotes={(notes.mine?.length ?? 0) + (notes.everywhere?.length ?? 0) > 0}
              onChange={setSummary}
            />
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
                <section key={category} aria-label={t(`categories.${category}`)} className="mb-5">
                  <div className="flex h-9 items-center gap-1.5">
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
                  </div>
                  {open && (
                    <ul className="mt-0.5">
                      {inGroup.map((note) => (
                        <li key={note.id} className="group/note flex items-center rounded-md hover:bg-bg-hover">
                          <button
                            type="button"
                            onClick={() => {
                              setError(null);
                              setDialog({ note, category: note.category });
                            }}
                            className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-start"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-start gap-1.5">
                                <span className="line-clamp-2 text-sm font-medium break-words text-fg">{note.text}</span>
                                {changes && (
                                  <Pencil aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint opacity-0 group-hover/note:opacity-100" />
                                )}
                              </span>
                              {note.details && <span className="mt-0.5 block truncate text-xs text-fg-muted">{note.details}</span>}
                            </span>
                            {author(note) && (
                              <span title={authorTitle(note)} className="hidden max-w-40 shrink-0 truncate text-xs text-fg-muted sm:block">
                                {author(note)}
                              </span>
                            )}
                            <time dateTime={note.updatedAt} className="w-20 shrink-0 text-end text-xs text-fg-faint tabular-nums">
                              {day(note.updatedAt)}
                            </time>
                          </button>
                          {changes && (
                            <IconButton
                              label={t("delete")}
                              title={t("delete")}
                              disabled={busy}
                              onClick={() => void change(section, { delete: note.id })}
                              className="me-1 h-7 w-7 shrink-0 opacity-0 group-hover/note:opacity-100 pointer-coarse:opacity-60 hover:text-danger focus-visible:opacity-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                          )}
                        </li>
                      ))}
                      {changes && !full && (
                        <li>
                          <NewRow label={t("addLabel")} onClick={() => startNew(category)} />
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })
          )}
          {list.length > 0 && (
            <p className="mt-2 text-xs text-fg-faint tabular-nums">
              {full ? t("full", { max: MAX_MEMORIES }) : t("count", { count: list.length, max: MAX_MEMORIES })}
            </p>
          )}
        </div>
      </div>
      {dialog && (
        <NoteDialog
          key={dialog.note?.id ?? "new"}
          note={dialog.note}
          category={dialog.category}
          readOnly={!changes}
          busy={busy}
          full={full}
          error={error}
          placeholder={placeholder}
          by={dialog.note ? author(dialog.note) : null}
          when={dialog.note ? day(dialog.note.updatedAt) : null}
          onSave={async (edit) => {
            if (await change(section, edit)) setDialog(null);
          }}
          onDelete={async (id) => {
            if (await change(section, { delete: id })) setDialog(null);
          }}
          onClose={() => {
            setError(null);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

/** The row under a group (or an empty list) that starts a new note. */
function NewRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg">
      <Plus className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

/** One note to read, change or delete, or a new one: its line, kind and details. */
function NoteDialog({
  note,
  category,
  readOnly,
  busy,
  full,
  error,
  placeholder,
  by,
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
  when: string | null;
  onSave: (edit: NoteChange) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations("ai.memory");
  const tc = useTranslations("common");
  const [text, setText] = useState(note?.text ?? "");
  const [kind, setKind] = useState<MemoryCategory>(note?.category ?? category);
  const [details, setDetails] = useState(note?.details ?? "");
  const blocked = readOnly || busy || !text.trim() || (!note && full);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    void onSave(
      note
        ? { id: note.id, text, category: kind, details }
        : { add: text, category: kind, ...(details.trim() ? { details } : {}) },
    );
  }

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <form onSubmit={submit}>
        <DialogHeader title={note ? t("editLabel") : t("addLabel")} onClose={onClose} closeLabel={tc("close")} />
        <DialogBody>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("editLabel")}</span>
            <textarea
              autoFocus={!readOnly}
              readOnly={readOnly}
              rows={2}
              className={cn(textareaClass, "min-h-16")}
              placeholder={placeholder}
              value={text}
              maxLength={MAX_MEMORY_CHARS}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // A note is one line: Enter keeps it.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("categoryLabel")}</span>
            <select
              className={cn(selectClass, "w-full")}
              value={kind}
              disabled={readOnly}
              onChange={(e) => {
                if (isMemoryCategory(e.target.value)) setKind(e.target.value);
              }}
            >
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("detailsLabel")}</span>
            <textarea
              readOnly={readOnly}
              rows={4}
              className={cn(textareaClass, "min-h-24")}
              placeholder={t("detailsPlaceholder")}
              value={details}
              maxLength={MAX_MEMORY_DETAILS_CHARS}
              onChange={(e) => setDetails(e.target.value)}
            />
          </label>
          {note && (by || when) && <p className="text-xs text-fg-faint tabular-nums">{[by, when].filter(Boolean).join(" · ")}</p>}
          {!note && full && <p className="text-xs text-fg-muted">{t("full", { max: MAX_MEMORIES })}</p>}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {note && !readOnly && (
            <Button variant="ghost" className="me-auto hover:text-danger" disabled={busy} onClick={() => void onDelete(note.id)}>
              {t("delete")}
            </Button>
          )}
          <Button onClick={onClose}>{readOnly ? tc("close") : t("cancel")}</Button>
          {!readOnly && (
            <Button type="submit" variant="primary" disabled={blocked}>
              {t("save")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
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
        <p key={blocks.length} className="pt-1 text-xs font-medium text-fg-muted">
          {line.slice(heading[0].length).trim()}
        </p>,
      );
    } else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="space-y-1 text-sm break-words">{blocks}</div>;
}

/**
 * The person's summary of their notes here: written by the AI when they ask, or by them; changed in
 * place or deleted, asking first where that loses what they wrote; marked when their notes changed
 * since, and held back from questions when a note it was written from did (until written again or
 * marked as up to date). `use`: their memory is on here, which writing and changing it needs.
 */
function SummaryBox({
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
    <section aria-label={t("summary.title")} className="mb-6 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{t("summary.title")}</h3>
          {!summary && <p className="text-xs text-fg-muted">{t("summary.hint")}</p>}
          {summary && editing === null && (
            <p className="text-xs text-fg-muted">
              {summary.writtenBy === "ai" ? t("summary.byAi", { date: when }) : t("summary.byYou", { date: when })}
              {summary.stale && !summary.withheld && ` · ${t("summary.stale")}`}
            </p>
          )}
          {summary?.withheld && editing === null && <p className="mt-1 text-xs text-danger">{t("summary.withheld")}</p>}
        </div>
        {editing === null && (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
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
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      {editing !== null ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("save", () => saveMemorySummaryAction(workspaceId, editing));
          }}
        >
          <textarea
            autoFocus
            aria-label={t("summary.title")}
            className={cn(textareaClass, "min-h-32")}
            rows={8}
            value={editing}
            maxLength={MAX_MEMORY_SUMMARY_CHARS}
            onChange={(e) => setEditing(e.target.value)}
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
        summary && (
          <div className="mt-2">
            <SummaryText text={summary.text} />
          </div>
        )
      )}
    </section>
  );
}

/** Whether a note (its line or its details) has every word of a search, any case. */
function matches(note: Note, words: string[], locale: string): boolean {
  const text = `${note.text}\n${note.details ?? ""}`.toLocaleLowerCase(locale);
  return words.every((word) => text.includes(word));
}

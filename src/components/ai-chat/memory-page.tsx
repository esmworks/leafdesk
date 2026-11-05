"use client";

/**
 * The Memory page: what the AI keeps for its answers, one part at a time down the side (`?section=`,
 * changed in place without a server round trip). The person's notes in this workspace (with their
 * "Use memory" switch) and everywhere (server/account-memory.ts), only theirs; the workspace's and
 * each teamspace's they are in (server/shared-memory.ts), which those in it read and those who
 * manage it change. While the workspace has the memory off, only the notes everywhere show.
 */
import { Check, ChevronRight, Eye, Pencil, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";
import { changeNoteAction, setMemoryUseAction, type NoteChange } from "@/app/actions/ai";
import { IconGlyph } from "@/components/builtin-icon";
import { useIsOffline } from "@/components/offline/offline-context";
import { Button, cn, IconButton, Input, selectClass, Switch, textareaClass } from "@/components/ui";
import { chatPath, isMemoryCategory, MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_MEMORY_DETAILS_CHARS, MEMORY_CATEGORIES, memoryPagePath, type MemoryCategory, type MemoryPlaceView, type MemoryView } from "@/lib/ai-chat";

type Note = MemoryView & { by?: string | null };
/** `mine` and `everywhere` are the person's; `workspace` the workspace's; anything else a teamspace's id. */
type Section = string;

export function MemoryPage({
  workspaceId,
  workspaceName,
  off,
  use: initialUse,
  mine: initialMine,
  account: initialAccount,
  workspace,
  teamspaces,
}: {
  workspaceId: string;
  workspaceName: string;
  /** The workspace's owners turned the memory off: only the person's notes everywhere show. */
  off: boolean;
  /** The person's own switch in this workspace. */
  use: boolean;
  mine: MemoryView[];
  account: MemoryView[];
  /** Null for a guest. */
  workspace: MemoryPlaceView | null;
  teamspaces: MemoryPlaceView[];
}) {
  const t = useTranslations("ai.memory");
  const tChat = useTranslations("ai.chat");
  const params = useSearchParams();
  const [notes, setNotes] = useState<Record<string, Note[]>>(() => ({
    mine: initialMine,
    everywhere: initialAccount,
    ...(workspace ? { workspace: workspace.notes } : {}),
    ...Object.fromEntries(teamspaces.map((place) => [place.id!, place.notes])),
  }));
  const [use, setUse] = useState(initialUse);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (result.ok) setNotes((current) => ({ ...current, [key]: result.data }));
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
  const confirmAll =
    section === "mine"
      ? t("confirmForgetAll")
      : section === "everywhere"
        ? t("confirmForgetEverywhere")
        : t("confirmDeleteAll", { place: label(section) });

  return (
    <div data-filled-fields className="mx-auto w-full max-w-[1040px] px-4 pt-14 pb-16 md:px-8 md:pt-2">
      <div className="flex h-11 items-center gap-1 text-sm text-fg-muted">
        <Link href={chatPath(workspaceId)} className="shrink-0 rounded-md px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
          {tChat("title")}
        </Link>
        <ChevronRight className="h-3 w-3 shrink-0 rtl:rotate-180" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg">{t("title")}</span>
      </div>

      <header className="mt-4 md:mt-6">
        <h1 className="font-display text-2xl tracking-tight">{t("title")}</h1>
        <p className="mt-1.5 max-w-[640px] text-sm text-fg-muted">{t("pageIntro")}</p>
        {off && <p className="mt-3 max-w-[640px] rounded-lg bg-bg-subtle px-4 py-3 text-[13px] text-fg-muted">{t("workspaceOff")}</p>}
      </header>

      <div className="mt-6 flex flex-col gap-6 md:mt-8 md:flex-row md:gap-12">
        {all.length > 1 && (
          // A phone has no room beside the section: the list is a row that scrolls on its own.
          <nav
            aria-label={t("title")}
            className="-mx-4 flex shrink-0 gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] md:sticky md:top-4 md:mx-0 md:w-[188px] md:flex-col md:self-start md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {yours.map((key) => (
              <NavItem key={key} current={section === key} count={notes[key]?.length ?? 0} onClick={() => go(key)}>
                {label(key)}
              </NavItem>
            ))}
            {shared.length > 0 && (
              <>
                <div className="shrink-0 px-2 pt-4 pb-1 text-xs text-fg-faint max-md:hidden">{t("sections.shared")}</div>
                <span className="mx-1 my-1.5 w-px shrink-0 bg-border md:hidden" aria-hidden />
              </>
            )}
            {shared.map((p) => (
              <NavItem key={keyOf(p)} current={section === keyOf(p)} count={notes[keyOf(p)]?.length ?? 0} onClick={() => go(keyOf(p))}>
                {p.icon && <IconGlyph icon={p.icon} className="h-4 w-4 shrink-0 text-[15px]" />}
                <span className="min-w-0 flex-1 truncate">{label(keyOf(p))}</span>
              </NavItem>
            ))}
          </nav>
        )}

        <section aria-label={label(section)} className="max-w-[640px] min-w-0 flex-1">
          <div className="mb-6">
            <h2 className="text-base font-semibold">{section === "workspace" ? workspaceName : label(section)}</h2>
            <p className="mt-1 text-[13px] text-fg-muted">{help}</p>
            {!canChange && (
              <p className="mt-3 flex gap-2 text-[13px] text-fg-muted">
                <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("readOnly")}
              </p>
            )}
          </div>
          {section === "mine" && (
            <div className="mb-6 flex items-start gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t("use")}</p>
                <p className="text-xs text-fg-muted">{t("useHint")}</p>
              </div>
              <Switch checked={use} label={t("use")} disabled={busy} onChange={(next) => void toggleUse(next)} />
            </div>
          )}
          {error && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {error}
            </p>
          )}
          <NoteList
            key={section}
            notes={notes[section] ?? []}
            canChange={canChange}
            busy={busy}
            shared={place !== null}
            placeholder={section === "mine" ? t("addPlaceholder") : section === "everywhere" ? t("addPlaceholderEverywhere") : t("addPlaceholderShared")}
            confirmAll={confirmAll}
            allLabel={place ? t("deleteAll") : t("forgetAll")}
            onChange={(edit) => change(section, edit)}
          />
        </section>
      </div>
    </div>
  );
}

function NavItem({ current, count, onClick, children }: { current: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-start text-sm whitespace-nowrap",
        current ? "bg-bg-hover font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {typeof children === "string" ? <span className="min-w-0 flex-1 truncate">{children}</span> : children}
      {count > 0 && <span className="text-xs text-fg-faint tabular-nums">{count}</span>}
    </button>
  );
}

/** Whether a note (its line or its details) has every word of a search, any case. */
function matches(note: Note, words: string[], locale: string): boolean {
  const text = `${note.text}\n${note.details ?? ""}`.toLocaleLowerCase(locale);
  return words.every((word) => text.includes(word));
}

/** Details longer than this, or of more lines, show folded until opened. */
const FOLD_CHARS = 240;
const FOLD_LINES = 3;
const folds = (details: string) => details.length > FOLD_CHARS || details.split("\n").length > FOLD_LINES;

/**
 * One part's notes, grouped by what they are about (flat while every note is `other`), with a
 * search and a filter by kind: each changed in place or deleted, a note to add and deleting them
 * all, for those who may.
 */
function NoteList({
  notes,
  canChange,
  busy,
  shared,
  placeholder,
  confirmAll,
  allLabel,
  onChange,
}: {
  notes: Note[];
  canChange: boolean;
  busy: boolean;
  /** The workspace's or a teamspace's: each note says who changed it last. */
  shared: boolean;
  placeholder: string;
  confirmAll: string;
  allLabel: string;
  onChange: (change: NoteChange) => Promise<boolean>;
}) {
  const t = useTranslations("ai.memory");
  const locale = useLocale();
  const offline = useIsOffline();
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>("other");
  // Null while the new note has no details box open.
  const [draftDetails, setDraftDetails] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; category: MemoryCategory; details: string } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<MemoryCategory | "all">("all");
  const changes = canChange && !offline;
  const full = notes.length >= MAX_MEMORIES;

  const words = query.toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  const shown = notes.filter((note) => (only === "all" || note.category === only) && matches(note, words, locale));
  // Notes kept before kinds existed are all `other`: a list of them alone has no headings.
  const grouped = notes.some((note) => note.category !== "other");
  const groups = grouped
    ? MEMORY_CATEGORIES.map((category) => ({ category, notes: shown.filter((note) => note.category === category) })).filter((group) => group.notes.length > 0)
    : [{ category: null, notes: shown }];

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    if (await onChange({ add: draft, category: draftCategory, ...(draftDetails?.trim() ? { details: draftDetails } : {}) })) {
      setDraft("");
      setDraftDetails(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    if (await onChange({ id: editing.id, text: editing.text, category: editing.category, details: editing.details })) setEditing(null);
  }

  const kindSelect = (value: MemoryCategory, onSelect: (next: MemoryCategory) => void, disabled = false) => (
    <select
      aria-label={t("categoryLabel")}
      className={cn(selectClass, "max-w-[9rem] shrink-0")}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isMemoryCategory(e.target.value)) onSelect(e.target.value);
      }}
    >
      {MEMORY_CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {t(`categories.${category}`)}
        </option>
      ))}
    </select>
  );

  const action = "h-7 w-7 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60";
  const row = (note: Note) =>
    editing?.id === note.id ? (
      <li key={note.id} className="py-1.5">
        <form
          onSubmit={save}
          className="space-y-1.5"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(null);
          }}
        >
          <div className="flex items-center gap-1">
            <Input autoFocus aria-label={t("editLabel")} value={editing.text} maxLength={MAX_MEMORY_CHARS} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            {kindSelect(editing.category, (category) => setEditing({ ...editing, category }))}
            <IconButton type="submit" label={t("save")} className="h-8 w-8" disabled={busy || !editing.text.trim()}>
              <Check className="h-4 w-4" />
            </IconButton>
            <IconButton label={t("cancel")} className="h-8 w-8" onClick={() => setEditing(null)}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <textarea
            aria-label={t("detailsLabel")}
            placeholder={t("detailsPlaceholder")}
            className={cn(textareaClass, "min-h-16")}
            rows={3}
            value={editing.details}
            maxLength={MAX_MEMORY_DETAILS_CHARS}
            onChange={(e) => setEditing({ ...editing, details: e.target.value })}
          />
        </form>
      </li>
    ) : (
      <li key={note.id} className="group/note flex items-start gap-1 py-1.5">
        <div className="min-w-0 flex-1 py-1">
          <p className="break-words">{note.text}</p>
          {note.details && (
            <>
              <p className={cn("mt-0.5 text-[13px] break-words whitespace-pre-wrap text-fg-muted", folds(note.details) && !open.has(note.id) && "line-clamp-3")}>{note.details}</p>
              {folds(note.details) && (
                <button
                  type="button"
                  className="text-xs text-fg-muted hover:text-fg"
                  aria-expanded={open.has(note.id)}
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (!next.delete(note.id)) next.add(note.id);
                      return next;
                    })
                  }
                >
                  {open.has(note.id) ? t("lessDetails") : t("moreDetails")}
                </button>
              )}
            </>
          )}
          {(note.app || (shared && note.by)) && (
            <p className="mt-0.5 text-xs text-fg-muted">{note.app ? t("viaApp", { app: note.app }) : t("byPerson", { name: note.by! })}</p>
          )}
        </div>
        {changes && (
          <>
            <IconButton label={t("edit")} className={action} disabled={busy} onClick={() => setEditing({ id: note.id, text: note.text, category: note.category, details: note.details ?? "" })}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t("delete")} className={action} disabled={busy} onClick={() => void onChange({ delete: note.id })}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
      </li>
    );

  return (
    <div className="space-y-3 text-sm">
      {offline && <p className="text-fg-muted">{t("offline")}</p>}
      {notes.length === 0 ? (
        <p className="text-fg-muted">{shared ? t("emptyShared") : t("empty")}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" aria-hidden />
              <Input type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="ps-7" />
            </div>
            <select
              aria-label={t("filterLabel")}
              className={cn(selectClass, "max-w-[10rem] shrink-0")}
              value={only}
              onChange={(e) => {
                const next = e.target.value;
                setOnly(isMemoryCategory(next) ? next : "all");
                // A note added while one kind is shown is of that kind.
                if (isMemoryCategory(next)) setDraftCategory(next);
              }}
            >
              <option value="all">{t("allCategories")}</option>
              {MEMORY_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`categories.${category}`)}
                </option>
              ))}
            </select>
          </div>
          {shown.length === 0 ? (
            <p className="text-fg-muted" aria-live="polite">
              {t("noMatch")}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.category ?? "all"}>
                {group.category && <h3 className="pt-2 pb-1 text-xs font-medium text-fg-muted">{t(`categories.${group.category}`)}</h3>}
                <ul className="divide-y divide-border border-y border-border">{group.notes.map(row)}</ul>
              </div>
            ))
          )}
        </>
      )}
      {changes && (
        <>
          <form onSubmit={add} className="flex gap-2">
            <Input
              aria-label={t("addLabel")}
              placeholder={full ? t("full", { max: MAX_MEMORIES }) : placeholder}
              value={draft}
              maxLength={MAX_MEMORY_CHARS}
              disabled={full}
              onChange={(e) => setDraft(e.target.value)}
            />
            {kindSelect(draftCategory, setDraftCategory, full)}
            <Button type="submit" variant="primary" disabled={busy || full || !draft.trim()}>
              {t("add")}
            </Button>
          </form>
          {!full &&
            (draftDetails === null ? (
              <Button size="sm" variant="ghost" className="-mt-1" onClick={() => setDraftDetails("")}>
                {t("addDetails")}
              </Button>
            ) : (
              <textarea
                autoFocus
                aria-label={t("detailsLabel")}
                placeholder={t("detailsPlaceholder")}
                className={cn(textareaClass, "min-h-16")}
                rows={3}
                value={draftDetails}
                maxLength={MAX_MEMORY_DETAILS_CHARS}
                onChange={(e) => setDraftDetails(e.target.value)}
              />
            ))}
          <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
            <span>{t("count", { count: notes.length, max: MAX_MEMORIES })}</span>
            {notes.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(confirmAll)) void onChange({ delete: "all" });
                }}
              >
                {allLabel}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

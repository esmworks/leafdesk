"use client";

/**
 * The Memory page's panel at the window's edge, loaded the first time it opens: one note (its line,
 * kind, who kept it, details, saved as each field is left) or the person's summary.
 */
import { ChevronsRight, CircleDot, Clock, Sparkles, Trash2, UserRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  deleteMemorySummaryAction,
  markMemorySummaryCurrentAction,
  saveMemorySummaryAction,
  writeMemorySummaryAction,
  type NoteChange,
} from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { Button, cn, IconButton, MenuItem, Popover, textareaClass } from "@/components/ui";
import {
  MAX_MEMORIES,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_DETAILS_CHARS,
  MAX_MEMORY_SUMMARY_CHARS,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemorySummaryView,
} from "@/lib/ai-chat";
import { onOtherSidePanel, openingSidePanel } from "@/lib/side-panels";
import { AuthorCard, Face, KIND_COLOR, type AuthorCardProps, type Note } from "./memory-parts";

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
export function NotePeek({
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
export function SummaryPeek({
  workspaceId,
  summary,
  use,
  hasNotes,
  onChange,
  onClose,
}: {
  workspaceId: string;
  summary: MemorySummaryView | null;
  use: boolean;
  hasNotes: boolean;
  onChange: (summary: MemorySummaryView | null) => void;
  onClose: () => void;
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
    <PeekPanel label={t("summary.title")} onClose={onClose}>
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
    </PeekPanel>
  );
}


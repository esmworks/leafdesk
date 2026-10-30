"use client";

import { FileText, History, RotateCcw, Sparkles, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadDatabaseHistoryAction, undoDatabaseHistoryAction } from "@/app/actions/databases";
import { IconGlyph } from "@/components/builtin-icon";
import { cn, IconButton } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { HistoryActor, PropertyField } from "@/lib/database-history";
import { pageLabel } from "@/lib/labels";
import { relativeTime } from "@/lib/relative-time";
import type { HistoryEntry } from "@/server/database-history";
import { OptionChip } from "./property-cell";
import { usePropertyTypeLabel } from "./property-icons";
import { Value } from "./row-activity";

/** Rows an entry names before it says how many more there are. */
const SHOWN_ROWS = 3;

/**
 * A database's history in a side panel: who added, changed or deleted its properties and shared
 * views, who put rows in the trash, and who changed values across its rows, newest first and a day
 * at a time, each change with an Undo for those who may make it. The database follows an undo on
 * its own (its schema and rows are pushed to everyone with it open).
 */
export function DatabaseHistoryPanel({ databaseId, onClose, onOpenRow }: { databaseId: string; onClose: () => void; onOpenRow?: (rowId: string) => void }) {
  const t = useTranslations("database.history");
  const tc = useTranslations("common");
  const tm = useTranslations("database.propertyMenu");
  const format = useFormatter();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What the last undo did, by entry, until the list is read again.
  const [outcome, setOutcome] = useState<{ id: string; text: string; failed?: boolean } | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (before: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const res = await loadDatabaseHistoryAction(databaseId, before);
        if (mine !== seq.current) return;
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setError(null);
        setEntries((current) => (before ? [...(current ?? []), ...res.data.entries] : res.data.entries));
        setNext(res.data.next);
      } catch {
        if (mine === seq.current) setError(tc("genericError"));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [databaseId, tc],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const undo = async (entry: HistoryEntry) => {
    setBusy(entry.id);
    setOutcome(null);
    try {
      const res = await undoDatabaseHistoryAction(databaseId, entry.id, tm("checkedText"));
      if (!res.ok) {
        setOutcome({ id: entry.id, text: res.error, failed: true });
        return;
      }
      const { done, skipped } = res.data;
      await load(null);
      setOutcome({ id: entry.id, text: skipped ? t("undonePartly", { done, skipped }) : t("undone") });
    } catch {
      setOutcome({ id: entry.id, text: tc("genericError"), failed: true });
    } finally {
      setBusy(null);
    }
  };

  // Entries under a heading for their day: today, yesterday, or the date.
  const days: { key: string; label: string; entries: HistoryEntry[] }[] = [];
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  for (const entry of entries ?? []) {
    const at = new Date(entry.at);
    const key = dayKey(at);
    let day = days.at(-1);
    if (day?.key !== key) {
      const label = key === dayKey(today) ? t("today") : key === dayKey(yesterday) ? t("yesterday") : format.dateTime(at, { dateStyle: "long" });
      day = { key, label, entries: [] };
      days.push(day);
    }
    day.entries.push(entry);
  }

  return (
    <aside
      role="dialog"
      aria-label={t("title")}
      className="fixed top-(--app-top) bottom-0 inset-e-(--chat-width) z-40 flex w-full flex-col border-s border-border bg-bg shadow-xl md:w-[440px]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4" aria-hidden /> {t("title")}
        </h2>
        <IconButton label={tc("close")} onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {entries === null ? (
          <p className="pt-4 text-sm text-fg-muted">{error ?? tc("loading")}</p>
        ) : entries.length === 0 ? (
          <p className="pt-4 text-sm text-fg-muted">{t("empty")}</p>
        ) : (
          days.map((day) => (
            <section key={day.key} aria-label={day.label}>
              <h3 className="sticky top-0 z-10 bg-bg pt-4 pb-1 text-xs font-medium text-fg-muted">{day.label}</h3>
              <ol className="flex flex-col">
                {day.entries.map((entry) => (
                  <Entry
                    key={entry.id}
                    entry={entry}
                    busy={busy === entry.id}
                    disabled={busy !== null}
                    outcome={outcome?.id === entry.id ? outcome : null}
                    onUndo={() => void undo(entry)}
                    onOpenRow={onOpenRow}
                  />
                ))}
              </ol>
            </section>
          ))
        )}
        {entries !== null && error && <p className="mt-3 text-xs text-danger">{error}</p>}
        {next && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(next)}
            className="mt-3 h-8 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
          >
            {loading ? tc("loading") : t("showMore")}
          </button>
        )}
      </div>
    </aside>
  );
}

function Entry({
  entry,
  busy,
  disabled,
  outcome,
  onUndo,
  onOpenRow,
}: {
  entry: HistoryEntry;
  busy: boolean;
  disabled: boolean;
  outcome: { text: string; failed?: boolean } | null;
  onUndo: () => void;
  onOpenRow?: (rowId: string) => void;
}) {
  const t = useTranslations("database.history");
  const tr = useTranslations("database.rowActivity");
  const tc = useTranslations("common");
  const tv = useTranslations("database.views");
  const locale = useLocale();
  const format = useFormatter();
  const typeLabel = usePropertyTypeLabel();
  const at = new Date(entry.at);
  const { person, kind } = entry.actor;
  const name = kind === "form" ? tr("formAnswer") : kind === "ai" ? tr("ai") : (person?.name ?? tr("someone"));
  const strong = (chunks: ReactNode) => <span className="font-medium text-fg">{chunks}</span>;
  const tags = {
    actor: () => (
      <>
        <bdi className="font-medium text-fg">{name}</bdi>
        {(kind === "agent" || kind === "automation" || kind === "button") && (
          <span className="ms-1 rounded bg-bg-active px-1 py-px align-[1px] text-[11px] leading-none text-fg-muted">{tr(kind)}</span>
        )}
        {kind === "ai" && <span className="ms-1">{tr("aiFor", { name: person?.name ?? tr("someone") })}</span>}
      </>
    ),
    prop: strong,
  };

  let sentence: ReactNode;
  let details: ReactNode = null;
  if (entry.type === "property") {
    const key = { property_added: "propertyAdded", property_changed: "propertyChanged", property_deleted: "propertyDeleted", property_restored: "propertyRestored" } as const;
    sentence = t.rich(key[entry.kind], { ...tags, name, property: entry.property.name || tc("untitled") });
    if (entry.kind === "property_added") details = <p className="text-xs text-fg-muted">{typeLabel(entry.property.type)}</p>;
    if (entry.fields.length || entry.values) details = <PropertyFields fields={entry.fields} values={entry.values} />;
  } else if (entry.type === "view") {
    const key = { view_added: "viewAdded", view_changed: "viewChanged", view_deleted: "viewDeleted", view_restored: "viewRestored" } as const;
    sentence = t.rich(key[entry.kind], { ...tags, name, view: entry.view.name || tc("untitled") });
    if (entry.kind === "view_changed" && entry.parts.length) {
      details = <p className="text-xs text-fg-muted">{t("partsChanged", { parts: format.list(entry.parts.map((p) => t(`parts.${p}`)), { type: "conjunction" }) })}</p>;
    } else if (entry.kind === "view_added") details = <p className="text-xs text-fg-muted">{tv(entry.view.type)}</p>;
  } else if (entry.type === "rows") {
    sentence = t.rich(entry.kind === "rows_trashed" ? "rowsTrashed" : "rowsRestored", { ...tags, name, count: entry.rows.length });
    details = <RowList rows={entry.rows} total={entry.rows.length} onOpenRow={entry.kind === "rows_restored" ? onOpenRow : undefined} />;
  } else {
    const args = { ...tags, name, count: entry.rows, property: entry.property?.name ?? "" };
    const empty = (v: typeof entry.to) => !v || v.type === "empty";
    if (entry.kind === "created") sentence = t.rich("rowsCreated", args);
    else if (entry.kind === "title") sentence = t.rich("rowsRetitled", args);
    else if (entry.to && empty(entry.to)) sentence = t.rich("valuesCleared", args);
    else if (entry.to) sentence = t.rich("valuesSet", { ...args, to: "", new: () => <Value value={entry.to} /> });
    else sentence = t.rich("valuesChanged", args);
    details = (
      <>
        {entry.kind === "property" && entry.from && !empty(entry.from) && (
          <p className="text-xs text-fg-muted">{t.rich("valuesWere", { from: "", old: () => <Value value={entry.from} /> })}</p>
        )}
        <RowList rows={entry.sample} total={entry.rows} onOpenRow={onOpenRow} />
      </>
    );
  }

  const gone = (entry.type === "property" && entry.property.state === "gone") || (entry.type === "view" && entry.view.state === "gone");
  return (
    <li className="group flex items-start gap-2.5 rounded-md py-2 text-sm">
      <Avatar actor={entry.actor} name={name} />
      <div className="min-w-0 flex-1">
        <p className="leading-5 break-words text-fg-muted">{sentence}</p>
        <time className="block text-xs leading-5 text-fg-faint" dateTime={entry.at} title={format.dateTime(at, { dateStyle: "full", timeStyle: "short" })}>
          {/* Under its day's heading: how long ago today, the time of day before. */}
          {at.toDateString() === new Date().toDateString() ? relativeTime(at, locale) : format.dateTime(at, { timeStyle: "short" })}
        </time>
        {details && <div className="mt-1 flex flex-col gap-1">{details}</div>}
        {gone && <p className="mt-0.5 text-xs text-fg-faint">{t("gone")}</p>}
        {outcome && <p className={cn("mt-1 text-xs", outcome.failed ? "text-danger" : "text-fg-muted")}>{outcome.text}</p>}
      </div>
      {entry.canUndo && (
        <button
          type="button"
          disabled={disabled}
          onClick={onUndo}
          className="mt-0.5 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg-muted opacity-100 hover:bg-bg-hover hover:text-fg focus-visible:opacity-100 disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {busy ? t("undoing") : t("undo")}
        </button>
      )}
    </li>
  );
}

/** What a property change did, a line per part: its name and type, its options, other settings. */
function PropertyFields({ fields, values }: { fields: PropertyField[]; values: number }) {
  const t = useTranslations("database.history");
  const typeLabel = usePropertyTypeLabel();
  const format = useFormatter();
  const old = (chunks: ReactNode) => <span className="text-fg-faint line-through">{chunks}</span>;
  const now = (chunks: ReactNode) => <span className="font-medium text-fg">{chunks}</span>;
  const settings = fields.flatMap((f) => (f.field === "setting" ? [t(`settings.${f.setting}`)] : []));
  const line = "text-xs leading-5 text-fg-muted";
  return (
    <>
      {fields.map((f, i) => {
        switch (f.field) {
          case "name":
            return (
              <p key={i} className={line}>
                {t.rich("fieldName", { from: f.from, to: f.to, old, new: now })}
              </p>
            );
          case "type":
            return (
              <p key={i} className={line}>
                {t.rich("fieldType", { from: typeLabel(f.from), to: typeLabel(f.to), old, new: now })}
              </p>
            );
          case "options":
            return (
              <div key={i} className={cn(line, "flex flex-col gap-1")}>
                {f.added.length > 0 && <Chips label={t("optionsAdded")} options={f.added} />}
                {f.removed.length > 0 && <Chips label={t("optionsRemoved")} options={f.removed} removed />}
                {f.renamed.map((r) => (
                  <p key={r.to.id}>{t.rich("optionRenamed", { from: r.from, to: r.to.name, old, new: now })}</p>
                ))}
                {f.recolored.length > 0 && <Chips label={t("optionsRecolored")} options={f.recolored} />}
                {!f.added.length && !f.removed.length && !f.renamed.length && !f.recolored.length && <p>{t("optionsReordered")}</p>}
              </div>
            );
          case "formula":
            return (
              <p key={i} className={line}>
                {t("fieldFormula")} <code className="rounded bg-bg-subtle px-1 py-px font-mono text-[11px] text-fg break-all">{f.to ?? ""}</code>
              </p>
            );
          case "description":
            return (
              <p key={i} className={line}>
                {t("fieldDescription")}
              </p>
            );
          default:
            return null;
        }
      })}
      {settings.length > 0 && <p className={line}>{t("settingsChanged", { settings: format.list(settings, { type: "conjunction" }) })}</p>}
      {values > 0 && <p className={line}>{t("valuesKept", { count: values })}</p>}
    </>
  );
}

function Chips({ label, options, removed = false }: { label: string; options: { id: string; name: string; color: string }[]; removed?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span>{label}</span>
      {options.map((o) => (
        <OptionChip key={o.id} option={o} className={cn(removed && "line-through opacity-70")} />
      ))}
    </div>
  );
}

/** A few of the rows an entry is about, each opening its row when it can, and how many more. */
function RowList({ rows, total, onOpenRow }: { rows: { id: string; title: string }[]; total: number; onOpenRow?: (rowId: string) => void }) {
  const t = useTranslations("database.history");
  const tc = useTranslations("common");
  const shown = rows.slice(0, SHOWN_ROWS);
  if (!shown.length) return null;
  const more = total - shown.length;
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
      {shown.map((row) => (
        <span key={row.id} className="inline-flex min-w-0 items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5">
          <FileText className="h-3 w-3 shrink-0 text-fg-faint" aria-hidden />
          {onOpenRow ? (
            <button type="button" onClick={() => onOpenRow(row.id)} className="max-w-48 truncate underline-offset-2 hover:text-fg hover:underline">
              {pageLabel(row.title, tc("untitled"))}
            </button>
          ) : (
            <span className="max-w-48 truncate">{pageLabel(row.title, tc("untitled"))}</span>
          )}
        </span>
      ))}
      {more > 0 && <span>{t("andMore", { count: more })}</span>}
    </p>
  );
}

function Avatar({ actor, name }: { actor: HistoryActor; name: string }) {
  const { person, kind } = actor;
  const box = "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted";
  if (kind === "form" || kind === "ai") {
    const Icon = kind === "form" ? FileText : Sparkles;
    return (
      <span aria-hidden className={box}>
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (person?.isAgent && person.agentIcon) {
    return (
      <span aria-hidden className={cn(box, "text-sm")}>
        <IconGlyph icon={person.agentIcon} className="h-3.5 w-3.5" />
      </span>
    );
  }
  return <UserAvatar name={name} image={person?.image} size="sm" className="mt-0.5" />;
}

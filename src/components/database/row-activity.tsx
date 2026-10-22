"use client";

import { ChevronDown, ChevronRight, FileText, Sparkles } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadRowActivityAction } from "@/app/actions/databases";
import { cn } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { UserAvatar } from "@/components/user-avatar";
import { MAX_ACTIVITY_PAGE, type ActivityValue } from "@/lib/row-activity";
import { relativeTime } from "@/lib/relative-time";
import type { RowActivityEntry } from "@/server/row-activity-feed";
import { OptionChip, useFormatDate } from "./property-cell";

/** Whether the viewer keeps the activity of row pages open; one choice for every row. */
const OPEN_KEY = "leafdesk:row-activity-open";
const PAGE = 20;
/** Long text values are cut here; the whole value shows on hover. */
const MAX_TEXT = 120;

function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {}
}

/**
 * A row's activity under its properties: who created it and who changed its title or a value,
 * newest first, a page at a time. Closed until the viewer opens it (remembered in this browser).
 * `signal` changes when the row's database changed: the entries shown are read again.
 */
export function RowActivity({ rowId, signal }: { rowId: string; signal: number }) {
  const t = useTranslations("database.rowActivity");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RowActivityEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const shown = useRef(PAGE);

  // Read after mounting: the server can't know what this browser chose.
  useEffect(() => setOpen(loadOpen()), []);

  const load = useCallback(
    async (offset: number, limit: number) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        // A read returns at most MAX_ACTIVITY_PAGE entries: reading again what was shown takes several.
        const read: RowActivityEntry[] = [];
        let more = true;
        while (more && read.length < limit) {
          const res = await loadRowActivityAction(rowId, offset + read.length, Math.min(MAX_ACTIVITY_PAGE, limit - read.length));
          if (mine !== seq.current) return;
          if (!res.ok) {
            setError(res.error);
            return;
          }
          read.push(...res.data.entries);
          more = res.data.hasMore && res.data.entries.length > 0;
        }
        setError(null);
        setEntries((current) => (offset === 0 ? read : [...(current ?? []), ...read]));
        setHasMore(more);
        shown.current = offset + read.length;
      } catch {
        if (mine === seq.current) setError(tc("genericError"));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [rowId, tc],
  );

  // Opened, and whenever the row may have changed: the entries shown so far, read again.
  useEffect(() => {
    if (open) void load(0, Math.max(PAGE, shown.current));
  }, [open, signal, load]);

  const toggle = () => {
    setOpen((v) => {
      saveOpen(!v);
      return !v;
    });
  };

  return (
    <section className="mt-1 print:hidden" aria-label={t("title")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex h-[30px] w-fit items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
        {t("title")}
      </button>
      {open && (
        <div className="mt-1 px-1">
          {entries === null ? (
            error ? (
              <p className="text-xs text-danger">{error}</p>
            ) : (
              <p className="text-sm text-fg-faint">{tc("loading")}</p>
            )
          ) : entries.length === 0 ? (
            <p className="text-sm text-fg-faint">{t("empty")}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
          {entries !== null && error && <p className="mt-2 text-xs text-danger">{error}</p>}
          {hasMore && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(shown.current, PAGE)}
              className="mt-2 h-7 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
            >
              {loading ? tc("loading") : t("showMore")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Entry({ entry }: { entry: RowActivityEntry }) {
  const t = useTranslations("database.rowActivity");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const at = new Date(entry.at);
  const { person, kind } = entry.actor;
  const name = kind === "form" ? t("formAnswer") : kind === "ai" ? t("ai") : (person?.name ?? t("someone"));
  const actor = (
    <>
      <bdi className="font-medium text-fg">{name}</bdi>
      {(kind === "agent" || kind === "automation") && (
        <span className="ms-1 rounded bg-bg-active px-1 py-px align-[1px] text-[11px] leading-none text-fg-muted">{t(kind)}</span>
      )}
      {/* An AI value names who it was worked out for: whoever asked, or whose change set it off. */}
      {kind === "ai" && <span className="ms-1">{t("aiFor", { name: person?.name ?? t("someone") })}</span>}
    </>
  );
  const tags = {
    actor: () => actor,
    prop: (chunks: ReactNode) => <span className="font-medium text-fg">{chunks}</span>,
    // The values show as chips, names and dates; the text the message holds for them goes unused.
    old: () => <Value value={entry.from} />,
    new: () => <Value value={entry.to} />,
  };
  const args = { name, property: entry.property?.name ?? "", from: "", to: "" };
  const empty = (v: ActivityValue | null) => !v || v.type === "empty";
  let sentence: ReactNode;
  if (entry.kind === "merged") {
    const titles = (entry.merged ?? []).map((row) => pageLabel(row.title, tc("untitled")));
    sentence = t.rich("merged", {
      ...args,
      ...tags,
      count: titles.length,
      titles: "",
      rows: () => <span className="font-medium text-fg">{format.list(titles, { type: "conjunction" })}</span>,
    });
  } else if (entry.kind === "created") sentence = t.rich("created", { ...args, ...tags });
  else if (entry.kind === "title") sentence = t.rich(empty(entry.from) ? "titled" : "renamed", { ...args, ...tags });
  else if (empty(entry.to)) sentence = t.rich("cleared", { ...args, ...tags });
  else if (empty(entry.from)) sentence = t.rich("set", { ...args, ...tags });
  else sentence = t.rich("changed", { ...args, ...tags });

  return (
    <li className="flex items-start gap-2 text-sm">
      <Avatar entry={entry} name={name} />
      <p className="min-w-0 flex-1 leading-6 break-words text-fg-muted">
        {sentence}{" "}
        {/* Came with a row merged into this one: which row it was. */}
        {entry.mergedFrom && (
          <span className="text-xs text-fg-faint">
            {t("mergedFrom", { title: pageLabel(entry.mergedFrom.title, tc("untitled")) })}{" "}
          </span>
        )}
        <span className="text-xs whitespace-nowrap text-fg-faint">
          <span aria-hidden>· </span>
          <time dateTime={entry.at} title={format.dateTime(at, { dateStyle: "full", timeStyle: "short" })}>
            {relativeTime(at, locale)}
          </time>
        </span>
      </p>
    </li>
  );
}

function Avatar({ entry, name }: { entry: RowActivityEntry; name: string }) {
  const { person, kind } = entry.actor;
  const box = "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted";
  if (kind === "form" || kind === "ai") {
    const Icon = kind === "form" ? FileText : Sparkles;
    return (
      <span aria-hidden className={box}>
        <Icon className="h-3 w-3" />
      </span>
    );
  }
  if (person?.isAgent && person.agentIcon) {
    return (
      <span aria-hidden className={cn(box, "text-xs")}>
        {person.agentIcon}
      </span>
    );
  }
  return <UserAvatar name={name} image={person?.image} size="xs" className="mt-0.5" />;
}

/** A value as the entry shows it: option chips, names, a date in the viewer's time zone… */
/** A value as a row's activity shows it: chips for options, names for people, dates in the viewer's zone. Also the inbox's, for rows people follow. */
export function Value({ value }: { value: ActivityValue | null }) {
  const t = useTranslations("database.rowActivity");
  const tc = useTranslations("common");
  const formatDate = useFormatDate();
  const strong = "font-medium text-fg";
  if (!value) return null;
  switch (value.type) {
    case "empty":
      return <span className="text-fg-faint">{t("nothing")}</span>;
    case "text": {
      const cut = value.text.length > MAX_TEXT;
      return (
        // Isolated so text written the other way doesn't pull the words around it (the time after it).
        <bdi className={strong} title={cut ? value.text : undefined}>
          {cut ? `${value.text.slice(0, MAX_TEXT)}…` : value.text}
        </bdi>
      );
    }
    case "number":
      return <span className={strong}>{value.value.toLocaleString()}</span>;
    case "checkbox":
      return <span className={strong}>{t(value.checked ? "checked" : "unchecked")}</span>;
    case "date":
      return <span className={strong}>{formatDate(value.value)}</span>;
    case "options":
      return (
        <span className="inline-flex flex-wrap items-center gap-1 align-middle">
          {value.options.map((o, i) => (
            <OptionChip key={i} option={{ id: String(i), ...o }} />
          ))}
          {value.missing > 0 && <span className="text-fg-faint">{t("deletedOption", { count: value.missing })}</span>}
        </span>
      );
    case "people":
      return (
        <span className={strong}>
          {[...value.people.map((p) => p.name), ...(value.missing ? [t("unknownPerson", { count: value.missing })] : [])].join(", ")}
        </span>
      );
    case "pages":
      return (
        <span>
          {value.pages.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              {"noAccess" in p ? (
                <span className="text-fg-faint">{t("noAccess")}</span>
              ) : (
                <span className={strong}>
                  {p.icon ? `${p.icon} ` : ""}
                  {p.title || tc("untitled")}
                </span>
              )}
            </span>
          ))}
        </span>
      );
    case "files":
      return <span className={strong}>{value.names.join(", ")}</span>;
    case "checklist":
      return <span className={strong}>{t("checklist", { done: value.done, total: value.total })}</span>;
  }
}

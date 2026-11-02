"use client";

import { Archive, ArrowDownUp, Calendar, Check, ChevronDown, CircleHelp, LayoutGrid, PenLine, UserRound, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn, MenuItem, MenuSeparator, menuFieldClass, PageIcon, Popover } from "@/components/ui";
import {
  MAX_FILTER_VALUES,
  SEARCH_DATE_PRESETS,
  SEARCH_SORTS,
  type SearchDateFilter,
  type SearchDateField,
  type SearchFilters,
  type SearchSort,
} from "@/lib/search-filter-state";
import { searchFold } from "@/lib/search-fold";
import type { SearchFilterOptions } from "@/server/search-filter-options";
import { read } from "@/components/read";

type PersonKey = "createdBy" | "editedBy";

/**
 * The search box's filters as one quiet row of menus under the query (loaded with the box,
 * lazily): teamspaces, who created a page, who last edited it, when it was last edited or created,
 * and whether archived pages are found too. A filter in use is drawn pressed with what it holds
 * and can be cleared on its own; they narrow the typed query and list pages without one. Last,
 * how the results are ordered.
 */
export function SearchFilterBar({
  workspaceId,
  filters,
  onChange,
  sort,
  onSortChange,
  includeOutdated,
  onIncludeOutdated,
}: {
  workspaceId: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
  includeOutdated: boolean;
  onIncludeOutdated: (on: boolean) => void;
}) {
  const t = useTranslations("sidebar.search.filters");
  const ts = useTranslations("sidebar.search");
  const [options, setOptions] = useState<SearchFilterOptions | null>(null);

  useEffect(() => {
    let live = true;
    read("searchFilterOptions", workspaceId).then(
      (found) => live && setOptions(found),
      () => live && setOptions({ me: null, teamspaces: [], people: [] }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((v) => v !== id) : list.length < MAX_FILTER_VALUES ? [...list, id] : list;
  const any = filters.teamspaceIds.length > 0 || filters.createdBy.length > 0 || filters.editedBy.length > 0 || filters.date !== null;

  const teamspaceNames = filters.teamspaceIds.map((id) => options?.teamspaces.find((ts) => ts.id === id)?.name ?? "…");
  const personName = (id: string) => options?.people.find((p) => p.id === id)?.name || options?.people.find((p) => p.id === id)?.email || "…";

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5" role="group" aria-label={t("label")}>
      {(options === null || options.teamspaces.length > 0) && (
        <FilterMenu
          icon={<LayoutGrid className="h-3.5 w-3.5" />}
          label={t("teamspace")}
          value={summary(teamspaceNames, t)}
          onClear={() => onChange({ ...filters, teamspaceIds: [] })}
          clearLabel={t("remove")}
        >
          {options?.teamspaces.map((ts) => (
            <MenuItem
              key={ts.id}
              icon={<PageIcon icon={ts.icon} className="text-sm" />}
              pressed={filters.teamspaceIds.includes(ts.id)}
              trailing={filters.teamspaceIds.includes(ts.id) ? <Check className="h-3.5 w-3.5" /> : undefined}
              onClick={() => onChange({ ...filters, teamspaceIds: toggle(filters.teamspaceIds, ts.id) })}
            >
              {ts.name}
            </MenuItem>
          ))}
        </FilterMenu>
      )}
      {(["createdBy", "editedBy"] as const).map((key: PersonKey) => (
        <FilterMenu
          key={key}
          icon={key === "createdBy" ? <UserRound className="h-3.5 w-3.5" /> : <PenLine className="h-3.5 w-3.5" />}
          label={t(key)}
          value={summary(filters[key].map(personName), t)}
          onClear={() => onChange({ ...filters, [key]: [] })}
          clearLabel={t("remove")}
          className="w-64"
        >
          <PeopleList
            me={options?.me ?? null}
            people={options?.people ?? []}
            selected={filters[key]}
            onToggle={(id) => onChange({ ...filters, [key]: toggle(filters[key], id) })}
          />
        </FilterMenu>
      ))}
      <DateMenu date={filters.date} onChange={(date) => onChange({ ...filters, date })} />
      <button
        type="button"
        aria-pressed={includeOutdated}
        title={ts("includeArchivedHint")}
        onClick={() => onIncludeOutdated(!includeOutdated)}
        className={cn(chipClass, includeOutdated ? "bg-bg-hover font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg")}
      >
        <Archive className="h-3.5 w-3.5" aria-hidden />
        <span className="truncate">{ts("includeArchived")}</span>
      </button>
      {any && (
        <button
          type="button"
          onClick={() => onChange({ teamspaceIds: [], createdBy: [], editedBy: [], date: null })}
          className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {t("clear")}
        </button>
      )}
      <span className="ms-auto">
        <FilterMenu
          icon={<ArrowDownUp className="h-3.5 w-3.5" />}
          label={t("sort")}
          value={sort === "relevance" ? null : t(`sorts.${sort}`)}
          onClear={() => onSortChange("relevance")}
          clearLabel={t("sortReset")}
          className="w-56"
          compact
        >
          {SEARCH_SORTS.map((s) => (
            <MenuItem key={s} pressed={sort === s} trailing={sort === s ? <Check className="h-3.5 w-3.5" /> : undefined} onClick={() => onSortChange(s)}>
              {t(`sorts.${s}`)}
            </MenuItem>
          ))}
        </FilterMenu>
      </span>
    </div>
  );
}

/** What a filter holds, short: one name, or the first and how many more. */
function summary(names: string[], t: ReturnType<typeof useTranslations<"sidebar.search.filters">>): string | null {
  if (!names.length) return null;
  return names.length === 1 ? names[0] : t("more", { first: names[0], count: names.length - 1 });
}

/** What the row's buttons share: a quiet word with an icon, pressed when in use. */
const chipClass = "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-xs";

/**
 * Under the results: what can be typed into the box (`in:`, `type:`, a phrase, a tag, `>`), each
 * put into it by a click. `onInsert` is the box's own insert. Behind a help icon, so the box
 * stays quiet.
 */
export function SearchSyntaxHelp({ onInsert, hasCommands }: { onInsert: (token: string) => void; hasCommands: boolean }) {
  const t = useTranslations("sidebar.search");
  const tj = useTranslations("journal");
  const hints: [string, string][] = [
    ['in:"…"', t("hint.in")],
    ["type:database", t("hint.type")],
    ["type:journal", tj("searchHint")],
    ['"…"', t("hint.phrase")],
    ["#…", t("hint.tag")],
    ...(hasCommands ? [[">", t("hint.commands")] as [string, string]] : []),
  ];
  // What a click puts in: the opening part of each token, left for the person to finish.
  const insert = (token: string) => onInsert(token === 'in:"…"' ? 'in:"' : token === '"…"' ? '"' : token === "#…" ? "#" : token);
  return (
    <Popover
      align="end"
      side="top"
      className="w-64"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          aria-label={t("syntax")}
          title={t("syntax")}
          onClick={toggle}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <CircleHelp className="h-4 w-4" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-muted">{t("syntax")}</p>
          {hints.map(([token, label]) => (
            <MenuItem
              key={token}
              onClick={() => {
                close();
                insert(token);
              }}
            >
              <span className="font-medium text-fg">{token}</span> <span className="text-fg-muted">{label}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

/**
 * A filter's button and its menu: its name alone while unused (`compact`: its icon alone, the
 * name as its tooltip), else its name and value with a button clearing it.
 */
function FilterMenu({
  icon,
  label,
  value,
  onClear,
  clearLabel,
  className,
  compact,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
  onClear: () => void;
  clearLabel: string;
  className?: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cn("inline-flex h-7 items-center rounded-md text-xs", value ? "bg-bg-hover font-medium text-fg" : "text-fg-muted")}>
      <Popover
        className={cn("max-h-72 overflow-y-auto", className)}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-expanded={open}
            aria-label={compact && !value ? label : undefined}
            title={compact && !value ? label : undefined}
            onClick={toggle}
            className={cn(chipClass, "h-full", !value && "hover:bg-bg-hover hover:text-fg")}
          >
            {icon}
            {(value || !compact) && <span className="truncate">{value ? `${label}: ${value}` : label}</span>}
            {!value && <ChevronDown className="h-3 w-3 text-fg-faint" aria-hidden />}
          </button>
        )}
      >
        {children}
      </Popover>
      {value && (
        <button type="button" onClick={onClear} aria-label={`${clearLabel}: ${label}`} title={clearLabel} className="inline-flex h-full items-center rounded-md pe-1.5 text-fg-muted hover:text-fg">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function PeopleList({
  me,
  people,
  selected,
  onToggle,
}: {
  me: string | null;
  people: SearchFilterOptions["people"];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("sidebar.search.filters");
  const [find, setFind] = useState("");
  const shown = useMemo(() => {
    const words = searchFold(find.trim()).split(/\s+/).filter(Boolean);
    return people.filter((p) => words.every((w) => searchFold(`${p.name} ${p.email}`).includes(w))).slice(0, 50);
  }, [people, find]);
  return (
    <>
      {people.length > 6 && (
        <div className="p-1">
          <input
            autoFocus
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder={t("findPerson")}
            aria-label={t("findPerson")}
            className={menuFieldClass}
          />
        </div>
      )}
      {shown.length === 0 && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noPeople")}</p>}
      {shown.map((p) => (
        <MenuItem
          key={p.id}
          pressed={selected.includes(p.id)}
          trailing={selected.includes(p.id) ? <Check className="h-3.5 w-3.5" /> : undefined}
          title={p.email}
          onClick={() => onToggle(p.id)}
        >
          {p.id === me ? t("you", { name: p.name || p.email }) : p.name || p.email}
        </MenuItem>
      ))}
    </>
  );
}

function DateMenu({ date, onChange }: { date: SearchDateFilter | null; onChange: (date: SearchDateFilter | null) => void }) {
  const t = useTranslations("sidebar.search.filters");
  const format = useFormatter();
  const [chosenField, setField] = useState<SearchDateField>(date?.field ?? "edited");
  const field = date?.field ?? chosenField;
  const day = (value: string) => format.dateTime(new Date(`${value}T00:00:00Z`), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  let value: string | null = null;
  if (date?.preset === "custom") {
    const range = date.from && date.to ? `${day(date.from)} – ${day(date.to)}` : date.from ? `≥ ${day(date.from)}` : `≤ ${day(date.to!)}`;
    value = range;
  } else if (date) value = t(date.preset);
  const [custom, setCustom] = useState(date?.preset === "custom");

  return (
    <FilterMenu icon={<Calendar className="h-3.5 w-3.5" />} label={date ? t(date.field) : t("date")} value={value} onClear={() => onChange(null)} clearLabel={t("remove")} className="w-60">
      <div className="grid grid-cols-2 gap-1 p-1" role="radiogroup" aria-label={t("date")}>
        {(["edited", "created"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={field === f}
            onClick={() => {
              setField(f);
              if (date) onChange({ ...date, field: f });
            }}
            className={cn(
              "h-7 rounded-md border px-2 text-xs",
              field === f ? "border-accent bg-bg-hover text-fg" : "border-border text-fg-muted hover:bg-bg-hover",
            )}
          >
            {t(f)}
          </button>
        ))}
      </div>
      <MenuSeparator />
      {SEARCH_DATE_PRESETS.filter((p) => p !== "custom").map((preset) => (
        <MenuItem
          key={preset}
          pressed={date?.preset === preset}
          trailing={date?.preset === preset ? <Check className="h-3.5 w-3.5" /> : undefined}
          onClick={() => {
            setCustom(false);
            onChange({ field, preset });
          }}
        >
          {t(preset)}
        </MenuItem>
      ))}
      <MenuItem pressed={custom} trailing={custom ? <Check className="h-3.5 w-3.5" /> : undefined} onClick={() => setCustom(true)}>
        {t("custom")}
      </MenuItem>
      {custom && (
        <div className="grid grid-cols-2 gap-1.5 p-1">
          {(["from", "to"] as const).map((end) => (
            <label key={end} className="block text-xs text-fg-muted">
              {t(end)}
              <input
                type="date"
                value={date?.preset === "custom" ? (date[end] ?? "") : ""}
                onChange={(e) => {
                  const next = { ...(date?.preset === "custom" ? date : {}), field, preset: "custom" as const, [end]: e.target.value || undefined };
                  onChange(next.from || next.to ? next : null);
                }}
                className={cn(menuFieldClass, "mt-0.5 text-xs")}
              />
            </label>
          ))}
        </div>
      )}
    </FilterMenu>
  );
}

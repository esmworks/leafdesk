"use client";

import { ArrowLeft, Check, ExternalLink, Plus, X } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listDatabasesAction } from "@/app/actions/databases";
import { Button, cn, Input, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { linkedRows, useRelations } from "./relation-context";
import type { Property, RelationInput, RelationTargetRow } from "./types";
import type { RelationTargetProperty } from "@/server/databases";
import { PeopleProvider, usePeople } from "./person-cell";
import { linksOne, shownParts, TITLE_FIELD } from "@/lib/relation-options";
import { searchFold } from "@/lib/search-fold";

/** Draws a value of a property of the related database, read-only (PropertyDisplay, passed in to keep the modules apart). */
export type RelatedValueRenderer = (prop: RelationTargetProperty, value: unknown) => ReactNode;

/**
 * Read-only list of linked rows (table cells, cards, panels): each row's title with the properties
 * the relation shows beside it, in its order (lib/relation-options), loaded with the rows.
 */
export function RelationChips({
  prop,
  value,
  wrap,
  renderValue,
}: {
  prop: Pick<Property, "id"> & { options: Pick<Property["options"], "relation"> };
  value: unknown;
  wrap?: boolean;
  renderValue?: RelatedValueRenderer;
}) {
  const ctx = useRelations();
  const target = ctx?.targets[prop.id];
  const rows = linkedRows(target, value);
  const outer = usePeople();
  // The people the linked rows' values name come with the related rows.
  const people = useMemo(
    () => (target?.people ? { viewerId: outer.viewerId, people: target.people } : outer),
    [target?.people, outer],
  );
  if (!rows.length) return null;
  const parts = renderValue ? shownParts(prop.options.relation) : [TITLE_FIELD];
  const chips = (
    <span className={cn("flex min-w-0 gap-x-2 gap-y-0.5", wrap ? "flex-wrap" : "overflow-hidden")}>
      {rows.map((row) => (
        <RelationChip key={row.id} row={row} parts={parts} properties={target?.properties} renderValue={renderValue} />
      ))}
    </span>
  );
  return people === outer ? chips : <PeopleProvider value={people}>{chips}</PeopleProvider>;
}

function RelationChip({
  row,
  parts,
  properties,
  renderValue,
}: {
  row: RelationTargetRow;
  parts: string[];
  properties?: RelationTargetProperty[];
  renderValue?: RelatedValueRenderer;
}) {
  const tc = useTranslations("common");
  return (
    <span className="inline-flex max-w-full min-w-0 shrink-0 items-center gap-1">
      {parts.map((part) => {
        if (part === TITLE_FIELD) {
          return (
            <Fragment key={part}>
              <PageIcon icon={row.icon} className="h-3.5 w-3.5 shrink-0 text-xs" />
              <span className="min-w-12 truncate underline decoration-border underline-offset-2">{pageLabel(row.title, tc("untitled"))}</span>
            </Fragment>
          );
        }
        const related = properties?.find((p) => p.id === part);
        const shown = related && !row.hidden?.includes(part) ? row.values?.[part] : undefined;
        if (!related || shown === undefined || !renderValue) return null;
        return (
          <span key={part} className="inline-flex max-w-32 min-w-0 shrink-[4] items-center overflow-hidden text-fg-muted">
            {renderValue(related, shown)}
          </span>
        );
      })}
    </span>
  );
}

/** Search the related database, toggle links, open linked rows, or create a new related row. */
export function RelationPicker({
  prop,
  value,
  onChange,
}: {
  prop: Property;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations("database.relation");
  const tc = useTranslations("common");
  const ctx = useRelations();
  const target = ctx?.targets[prop.id];
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  // Local selection so quick toggles don't race the optimistic parent state.
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  // Case-insensitive, with the dotted and dotless i alike (see searchFold).
  const lower = searchFold;
  const q = lower(query.trim());
  const rows = target?.rows ?? [];
  // A row is found by its ID too ("TASK-12", lib/unique-id) when its database numbers its rows.
  const filtered = q ? rows.filter((r) => lower(r.title).includes(q) || (r.uniqueId && lower(r.uniqueId).includes(q))) : rows;
  const canCreate = q.length > 0 && !rows.some((r) => lower(r.title.trim()) === q);
  const items: ({ kind: "row"; row: RelationTargetRow } | { kind: "create" })[] = [
    ...filtered.map((row) => ({ kind: "row" as const, row })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
  ];
  const selected = linkedRows(target, selectedIds);

  if (!ctx || !target?.database) {
    return <div className="w-72 px-3 py-2.5 text-sm text-fg-muted">{t("missingDatabase")}</div>;
  }
  const database = target.database;
  const href = (id: string) => `/w/${ctx.workspaceId}/p/${id}`;

  const setIds = (ids: string[]) => {
    setSelectedIds(ids);
    onChange(ids.length ? ids : null);
  };
  // A row's parent (sub-items), or a relation limited to one row: picking another replaces it, and
  // picking any row of a value that holds more (from before the limit) keeps just that one.
  const single = linksOne(prop.options.relation);
  const toggle = (id: string) =>
    setIds(
      single
        ? selectedIds.length === 1 && selectedIds[0] === id
          ? []
          : [id]
        : selectedIds.includes(id)
          ? selectedIds.filter((x) => x !== id)
          : [...selectedIds, id],
    );
  // Unlinking one of several in a value limited to one keeps the first of the others.
  const unlink = (id: string) => {
    const rest = selectedIds.filter((x) => x !== id);
    setIds(single ? rest.slice(0, 1) : rest);
  };

  const create = async () => {
    const title = query.trim();
    if (!title || busy) return;
    setBusy(true);
    const id = await ctx.createRow(database.id, title);
    setBusy(false);
    if (!id) return;
    setQuery("");
    setIds(single ? [id] : [...selectedIds, id]);
  };

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "create") void create();
    else toggle(item.row.id);
  };

  return (
    <div className="w-80">
      <div className="flex items-center gap-1.5 border-b border-border bg-bg-subtle px-2 py-1.5">
        <PageIcon icon={database.icon} kind="database" className="h-3.5 w-3.5 shrink-0 text-xs" />
        <input
          ref={input}
          value={query}
          placeholder={t("search", { title: pageLabel(database.title, tc("untitled")) })}
          aria-label={t("input", { property: prop.name })}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      {selected.length > 0 && (
        <div className="border-b border-border p-1">
          <div className="px-2 pt-1 pb-1 text-xs text-fg-muted">{t("linked")}</div>
          {single && selected.length > 1 && <div className="px-2 pb-1 text-xs text-fg-faint">{t("overLimit")}</div>}
          {selected.map((row) => {
            const title = pageLabel(row.title, tc("untitled"));
            return (
              <div key={row.id} className="group flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-bg-hover">
                <PageIcon icon={row.icon} className="h-3.5 w-3.5 shrink-0 text-xs" />
                <span className="flex-1 truncate">{title}</span>
                <Link
                  href={href(row.id)}
                  aria-label={t("open", { title })}
                  title={t("open", { title })}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
                <button
                  type="button"
                  aria-label={t("unlink", { title })}
                  title={t("unlink", { title })}
                  onClick={() => unlink(row.id)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto p-1">
        {!items.length && (
          <div className="px-2 py-1.5 text-xs text-fg-faint">{rows.length ? t("noMatches") : t("noRows")}</div>
        )}
        {items.map((item, i) =>
          item.kind === "create" ? (
            <button
              key="__create"
              type="button"
              disabled={busy}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-start text-sm",
                i === active && "bg-bg-hover",
              )}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <span className="shrink-0 text-fg-muted">{t("newRow")}</span>
              <span className="truncate">{query.trim()}</span>
            </button>
          ) : (
            <button
              key={item.row.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-start text-sm",
                i === active && "bg-bg-hover",
              )}
            >
              <PageIcon icon={item.row.icon} className="h-3.5 w-3.5 shrink-0 text-xs" />
              <span className="flex-1 truncate">{pageLabel(item.row.title, tc("untitled"))}</span>
              {item.row.uniqueId && <span className="shrink-0 text-xs text-fg-faint tabular-nums">{item.row.uniqueId}</span>}
              {selectedIds.includes(item.row.id) && <Check className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** Second step of "add property" for relations: pick the related database and two-way options. */
export function RelationSetup({
  name,
  onCreate,
  onBack,
}: {
  name: string;
  onCreate: (relation: RelationInput) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.relation");
  const tc = useTranslations("common");
  const locale = useLocale();
  const untitled = tc("untitled");
  const ctx = useRelations();
  const [databases, setDatabases] = useState<{ id: string; title: string; icon: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [twoWay, setTwoWay] = useState(true);
  const [pairedName, setPairedName] = useState("");

  const workspaceId = ctx?.workspaceId;
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void listDatabasesAction(workspaceId).then((res) => {
      if (!live) return;
      if (res.ok) {
        const label = (title: string) => pageLabel(title, untitled);
        setDatabases([...res.data].sort((a, b) => label(a.title).localeCompare(label(b.title), locale)));
      }
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, locale, untitled]);

  if (!ctx) return null;
  const target = databases?.find((d) => d.id === targetId);
  const targetTitle = target ? pageLabel(target.title, tc("untitled")) : "";
  const self = target?.id === ctx.databaseId;
  // The freshly listed title wins over the page's, which may predate a rename.
  const ownTitle = databases?.find((d) => d.id === ctx.databaseId)?.title || ctx.databaseTitle;

  return (
    <div className="w-72">
      <div className="flex items-center gap-1 px-1 pt-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="truncate text-sm font-medium">{name}</span>
      </div>
      <div className="px-2 pt-2 pb-1 text-xs text-fg-muted">{t("chooseDatabase")}</div>
      <div className="max-h-56 overflow-y-auto px-1">
        {error && <div className="px-2 py-1.5 text-xs text-danger">{error}</div>}
        {!databases && !error && <div className="px-2 py-1.5 text-xs text-fg-faint">{t("loadingDatabases")}</div>}
        {databases?.map((d) => {
          const title = pageLabel(d.title, tc("untitled"));
          return (
            <button
              key={d.id}
              type="button"
              aria-pressed={d.id === targetId}
              onClick={() => {
                setTargetId(d.id);
                setPairedName("");
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover",
                d.id === targetId && "bg-bg-hover",
              )}
            >
              <PageIcon icon={d.icon} kind="database" className="h-3.5 w-3.5 shrink-0 text-xs" />
              <span className="flex-1 truncate">{d.id === ctx.databaseId ? t("thisDatabase", { title }) : title}</span>
              {d.id === targetId && <Check className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
            </button>
          );
        })}
      </div>
      {target && (
        <div className="mt-1 border-t border-border p-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={twoWay}
              onChange={(e) => setTwoWay(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              {t("twoWay", { title: targetTitle })}
              <span className="block text-xs text-fg-muted">{t("twoWayHint")}</span>
            </span>
          </label>
          {twoWay && (
            <Input
              value={pairedName}
              placeholder={self ? name : pageLabel(ownTitle, tc("untitled"))}
              aria-label={t("pairedName", { title: targetTitle })}
              title={t("pairedName", { title: targetTitle })}
              onChange={(e) => setPairedName(e.target.value)}
              className="mt-2 h-7"
            />
          )}
          <Button
            size="sm"
            variant="primary"
            className="mt-2 w-full justify-center"
            onClick={() =>
              onCreate({
                databaseId: target.id,
                twoWay,
                pairedName: pairedName.trim() || (self ? name : ownTitle),
              })
            }
          >
            {t("create")}
          </Button>
        </div>
      )}
    </div>
  );
}

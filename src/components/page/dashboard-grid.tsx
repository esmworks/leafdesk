"use client";

import { ArrowLeft, ArrowRight, Lock, Mail, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { widgetDataAction, widgetRowsAction, widgetStampsAction } from "@/app/actions/dashboards";
import { useChannel } from "@/components/collab/use-channel";
import { Chart, NumberFigure, useMeasureName, type OpenedMark } from "@/components/database/chart-view";
import { Floating, useFloating } from "@/components/database/floating";
import { useFormatResult } from "@/components/database/table-calculations";
import { useViewerTimeZone } from "@/components/database/use-today";
import { useReorderDrag, type ReorderDragHandlers } from "@/components/use-reorder-drag";
import { Button, cn, IconButton, Input, MenuItem, MenuSeparator, PageIcon, pageLabel, selectClass } from "@/components/ui";
import type { FilterEntry } from "@/db/schema/app";
import type { AggregateFn } from "@/lib/aggregate";
import { chartMeasure } from "@/lib/chart";
import {
  dashboardDatabaseIds,
  MAX_WIDGET_TITLE,
  MAX_WIDGETS,
  moveWidget,
  newWidget,
  placeWidget,
  updateWidget,
  WIDGET_SPANS,
  type DashboardWidget,
  type WidgetSpan,
  newWidgetId,
  staleWidgets,
  widgetBoxClass,
  widgetStamp,
  WIDGET_COLORS,
  type WidgetColor,
  RECENT_ROWS_SORT,
  DASHBOARD_CLASS,
  DASHBOARD_GRID_CLASS,
  WIDGET_SPAN_CLASS,
} from "@/lib/dashboard";
import {
  COMPARISONS,
  comparisonOf,
  figureChange,
  PERIOD_NONE,
  periodProperty,
  serializeDashboardPeriod,
  withPeriod,
  type Comparison,
} from "@/lib/dashboard-period";
import type { DashboardEmailTarget } from "@/lib/dashboard-emails";
import type { LinkedView } from "@/lib/embed-blocks";
import type { WidgetData, WidgetRow, WidgetTarget } from "@/server/dashboards";
import { ChangeLine, PeriodBar, useDashboardPeriod, useRangeName } from "./dashboard-period";
import { DatabaseEmbed } from "./database-embed";
import { DatabasePicker } from "./database-picker";
import { lazyPart } from "@/components/lazy-part";

/**
 * A dashboard's grid (see lib/dashboard): widgets, each a view of a database the reader may see.
 * Numbers, charts and lists come worked out from the server (server/dashboards) and are asked for
 * again when their database changes (its rows, or how the reader sees it); other layouts are
 * linked views. Editors set a widget up in place, with the linked view's own toolbar.
 *
 * Two hosts: the dashboard block (components/page/dashboard-block), whose widgets show any
 * database of the workspace, and a database's dashboard views (components/database/dashboard-view),
 * whose widgets all show that database.
 */
// Loaded when someone opens a dashboard's emails.
const DashboardEmailsDialog = lazyPart(() => import("./dashboard-emails-dialog").then((m) => m.default));

/** What a dragged widget carries: not text, so the editor around the dashboard leaves the drop alone. */
const WIDGET_DRAG_TYPE = "application/x-leafdesk-widget";

export function Dashboard({
  widgets,
  onChange,
  workspaceId,
  databaseId,
  period: storedPeriod,
  onPeriod,
  emailTarget,
}: {
  widgets: DashboardWidget[];
  /** Only for those who may change the widgets. */
  onChange?: (widgets: DashboardWidget[]) => void;
  workspaceId: string | null;
  /** A dashboard view's database: every widget shows it, so new ones need no picking and none is named. */
  databaseId?: string;
  /** The period every widget shows, as stored (lib/dashboard-period); readers may pick another for themselves. */
  period?: string;
  /** Only for those who may change the widgets: store the period. */
  onPeriod?: (period: string) => void;
  /** The page and dashboard its emails are about (components/page/dashboard-emails-dialog); none offers no emails. */
  emailTarget?: { pageId: string; target: DashboardEmailTarget };
}) {
  const t = useTranslations("page.dashboard");
  const td = useTranslations("database.dashboardView");
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const full = widgets.length >= MAX_WIDGETS;
  const shown = useRef(new Map<string, ShownWidget>());
  useTreeRefresh(workspaceId, shown);
  const chosen = useDashboardPeriod(storedPeriod);
  const period = serializeDashboardPeriod(chosen.period);
  const drag = useReorderDrag("grid", (moved, target, side) => onChange?.(placeWidget(widgets, moved, target, side)), WIDGET_DRAG_TYPE);

  const add = (databaseId: string) => {
    setPicking(false);
    if (!onChange || full) return;
    const widget = newWidget(newWidgetId(widgets), databaseId);
    onChange([...widgets, widget]);
    setEditing(widget.id);
  };

  const addButton = onChange && (
    <Button size="sm" variant="ghost" onClick={() => (databaseId ? add(databaseId) : setPicking(true))} disabled={full} title={full ? t("full", { max: MAX_WIDGETS }) : undefined}>
      <Plus className="h-3.5 w-3.5" />
      {t("add")}
    </Button>
  );

  return (
    <div className={cn("dashboard my-2", DASHBOARD_CLASS)} contentEditable={false}>
      {widgets.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
          <div>
            <p className="text-sm font-medium">{t("title")}</p>
            <p className="mt-0.5 text-sm text-fg-muted">{onChange ? (databaseId ? td("emptyEditable") : t("emptyEditable")) : t("empty")}</p>
          </div>
          {addButton}
        </div>
      ) : (
        <>
          <PeriodBar
            period={chosen.period}
            onPick={chosen.pick}
            changed={chosen.picked}
            onReset={chosen.reset}
            trailing={
              emailTarget && (
                <Button size="sm" variant="ghost" onClick={() => setEmailing(true)} title={t("emails.buttonHint")}>
                  <Mail className="h-3.5 w-3.5" />
                  {t("emails.button")}
                </Button>
              )
            }
            onSave={
              onChange && onPeriod
                ? () => {
                    onPeriod(period);
                    chosen.reset();
                  }
                : undefined
            }
          />
          <div className={DASHBOARD_GRID_CLASS}>
            {widgets.map((widget, index) => (
              <Widget
                key={widget.id}
                widget={widget}
                period={period}
                shown={shown}
                fixed={!!databaseId}
                editing={editing === widget.id}
                drag={onChange && editing !== widget.id ? drag.handlers(widget.id) : undefined}
                actions={
                  onChange && {
                    first: index === 0,
                    last: index === widgets.length - 1,
                    edit: () => setEditing(widget.id),
                    done: () => setEditing(null),
                    change: (next) => onChange(updateWidget(widgets, widget.id, () => next)),
                    move: (by) => onChange(moveWidget(widgets, widget.id, by)),
                    remove: () => {
                      if (editing === widget.id) setEditing(null);
                      onChange(updateWidget(widgets, widget.id, () => null));
                    },
                  }
                }
              />
            ))}
          </div>
          {addButton && <div className="mt-1.5">{addButton}</div>}
        </>
      )}
      {workspaceId && onChange && !databaseId && (
        <DatabasePicker open={picking} workspaceId={workspaceId} onPick={add} onClose={() => setPicking(false)} />
      )}
      {emailTarget && emailing && <DashboardEmailsDialog open onClose={() => setEmailing(false)} {...emailTarget} />}
    </div>
  );
}

type WidgetActions = {
  first: boolean;
  last: boolean;
  edit: () => void;
  done: () => void;
  change: (widget: DashboardWidget) => void;
  move: (by: number) => void;
  remove: () => void;
};

/** A widget as the dashboard knows it: its database, how that looked when the widget loaded, and how to load again. */
type ShownWidget = { databaseId: string; stamp: string | null; reload: () => void };

/**
 * Sharing, moving, trashing and renaming change what the reader sees of a database but only signal
 * the workspace's page tree, which changes with every page anyone creates or renames. So once a
 * burst of tree changes settles, the dashboard asks for its databases' stamps in one request and
 * loads again only the widgets whose database changed (lib/dashboard widgetStamp).
 */
function useTreeRefresh(workspaceId: string | null, shown: RefObject<Map<string, ShownWidget>>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = useCallback(async () => {
    const list = [...shown.current].map(([id, w]) => ({ id, ...w }));
    if (!list.length) return;
    const now = await widgetStampsAction(dashboardDatabaseIds(list)).catch(() => null);
    // Without stamps nothing tells which changed: load them all, as a change of the tree may matter.
    const stale = now ? new Set(staleWidgets(list, now)) : null;
    for (const w of list) if (!stale || stale.has(w.id)) w.reload();
  }, [shown]);
  useChannel(workspaceId ? `ws:${workspaceId}` : null, (event) => {
    if (event !== "tree") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void check(), 300);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}

/**
 * A widget's data, asked for again (shortly after) whenever its database's rows or schema change,
 * or the dashboard finds the database changed for the reader (useTreeRefresh).
 */
function useWidgetData(widget: DashboardWidget, period: string, shown: RefObject<Map<string, ShownWidget>>) {
  const timeZone = useViewerTimeZone();
  // What came back, with the view it was asked for: a widget being changed is drawn and named as
  // the data it has until the data for its new settings comes.
  const [got, setGot] = useState<{ data: WidgetData; key: string; view: LinkedView } | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const { id, databaseId, view } = widget;
  const key = JSON.stringify({ databaseId, view });
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    try {
      const source = JSON.parse(key) as { databaseId: string; view: LinkedView };
      const next = await widgetDataAction(source, timeZone, period);
      if (n !== asked.current) return;
      setGot({ data: next, key, view: source.view });
      setFailed(false);
      setFetchedAt(Date.now());
    } catch {
      if (n === asked.current) setFailed(true);
    }
  }, [key, timeZone, period]);
  useEffect(() => {
    void load();
  }, [load]);

  // Edits come in bursts (a pasted column, a bulk change): one request after they settle.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 300);
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // Reactions and comments on rows change no number, chart or list.
  useChannel(`db:${databaseId}`, (event) => void (event !== "reactions" && event !== "comments" && later()));

  const data = got?.data ?? null;
  const stamp = data && !failed ? widgetStamp(data.state === "ok" ? data.database : null) : null;
  useEffect(() => {
    const map = shown.current;
    map.set(id, { databaseId, stamp, reload: load });
    return () => void map.delete(id);
  }, [shown, id, databaseId, stamp, load]);

  return { data, staleView: got && got.key !== key ? got.view : null, failed, fetchedAt, retry: load };
}

function Widget({
  widget,
  period,
  shown,
  fixed,
  editing,
  drag,
  actions,
}: {
  widget: DashboardWidget;
  /** The dashboard's period, as stored (lib/dashboard-period). */
  period: string;
  shown: RefObject<Map<string, ShownWidget>>;
  /** Of a dashboard view: the database goes without saying, and the widget is named after what it shows. */
  fixed: boolean;
  editing: boolean;
  /** Editors move a widget by dragging its title bar onto another widget. */
  drag?: ReorderDragHandlers;
  actions?: WidgetActions;
}) {
  const t = useTranslations("page.dashboard");
  const tc = useTranslations("common");
  const { data, staleView, failed, fetchedAt, retry } = useWidgetData(widget, period, shown);
  const ok = data?.state === "ok" ? data : null;
  const drawn = useMemo(() => (staleView ? { ...widget, view: staleView } : widget), [widget, staleView]);
  const shows = useWidgetName(drawn, ok);
  const title = widget.title || (fixed ? shows : ok ? pageLabel(ok.database.title, tc("untitled")) : "");
  const href = ok && !fixed ? `/w/${ok.database.workspaceId}/p/${ok.database.id}` : null;

  let body: ReactNode;
  if (editing && actions) body = <WidgetEditor widget={widget} actions={actions} fixed={fixed} data={ok} />;
  else if (!data && failed) {
    body = (
      <Notice>
        <span className="flex-1">{t("loadFailed")}</span>
        <Button size="sm" variant="ghost" onClick={() => void retry()}>
          {t("retry")}
        </Button>
      </Notice>
    );
  } else if (!data) body = <div aria-busy="true" aria-label={tc("loading")} className="h-20 animate-pulse rounded-md bg-bg-subtle" />;
  else if (data.state === "unavailable") {
    body = (
      <Notice>
        <Lock className="h-4 w-4 shrink-0" />
        {t("unavailable")}
      </Notice>
    );
  } else if (data.database.inTrash) {
    body = (
      <Notice>
        <Trash2 className="h-4 w-4 shrink-0" />
        {t("inTrash")}
      </Notice>
    );
  } else body = <WidgetBody widget={drawn} data={data} title={title} period={period} />;

  const box = useRef<HTMLElement>(null);
  return (
    <section
      ref={box}
      aria-label={title || undefined}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={cn(
        "relative flex min-w-0 flex-col rounded-lg border p-3",
        widgetBoxClass(widget.color),
        WIDGET_SPAN_CLASS[editing ? 4 : widget.span],
        drag?.dragging && "opacity-50",
      )}
    >
      {drag?.dropSide && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-10 rounded bg-accent",
            drag.dropAxis === "y" ? "inset-x-0 h-0.5" : "inset-y-0 w-0.5",
            drag.dropAxis === "y"
              ? drag.dropSide === "before"
                ? "-top-[7px]"
                : "-bottom-[7px]"
              : drag.dropSide === "before"
                ? "-inset-s-[7px]"
                : "-inset-e-[7px]",
          )}
        />
      )}
      <div
        draggable={!!drag}
        onDragStart={
          drag &&
          ((e) => {
            // The whole widget goes with the pointer, held where it was picked up.
            const el = box.current;
            if (el) {
              const at = el.getBoundingClientRect();
              e.dataTransfer.setDragImage(el, e.clientX - at.left, e.clientY - at.top);
            }
            drag.onDragStart(e);
          })
        }
        onDragEnd={drag?.onDragEnd}
        className={cn("flex min-h-6 min-w-0 items-center gap-1.5", drag && "cursor-grab active:cursor-grabbing")}
      >
        {ok && !fixed && <PageIcon icon={ok.database.icon} kind="database" className="text-sm" />}
        {href ? (
          <Link href={href} draggable={false} className="min-w-0 truncate text-sm font-medium hover:underline">
            {title}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        )}
        {actions && !editing && <WidgetMenu widget={widget} actions={actions} />}
      </div>
      <div className="mt-2 min-h-0 min-w-0 flex-1">{body}</div>
      {!editing && ok && !ok.database.inTrash && <WidgetFooter widget={drawn} data={ok} fetchedAt={fetchedAt} />}
    </section>
  );
}

type OkData = Extract<WidgetData, { state: "ok" }>;

/**
 * What a widget shows, in words, to name it on a dashboard view (where the database's name would
 * name them all): "Count", "Sum of Amount by Status", "Recently edited", "Board".
 */
function useWidgetName(widget: DashboardWidget, data: OkData | null): string {
  const t = useTranslations("database.dashboardView");
  const td = useTranslations("database");
  const config = widget.view.config;
  const properties = data?.properties;
  const measure = useMemo(() => chartMeasure(config, properties ?? []), [config, properties]);
  const measureName = useMeasureName(measure, properties ?? []);
  if (!data) return "";
  if (data.kind === "number") return measureName;
  if (data.kind === "chart") {
    const groupBy = data.properties.find((p) => p.id === data.groupById);
    return groupBy ? t("chartTitle", { measure: measureName, property: groupBy.name }) : measureName;
  }
  const sort = config.sorts?.[0];
  if (widget.view.type === "list" && sort?.propertyId === RECENT_ROWS_SORT.propertyId && sort.direction === RECENT_ROWS_SORT.direction) return t("recent");
  return td(`views.${widget.view.type}`);
}

function WidgetBody({ widget, data, title, period }: { widget: DashboardWidget; data: OkData; title: string; period: string }) {
  const t = useTranslations("page.dashboard");
  const td = useTranslations("database");
  const formatResult = useFormatResult();
  const rangeName = useRangeName();
  const config = widget.view.config;
  // A layout shown as a linked view gets the period as two more filter rules, the days the server worked out.
  const cut = data.period?.property ? { id: data.period.property.id, range: data.period.range } : null;
  const readOnlyView = useMemo(
    () => ({ view: cut ? { ...widget.view, config: withPeriod(widget.view.config, cut.id, cut.range) } : widget.view }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cut changes with its id and days only
    [widget.view, cut?.id, cut?.range.start, cut?.range.end],
  );
  const measure = useMemo(() => chartMeasure(config, data.properties), [config, data.properties]);
  const measureName = useMeasureName(measure, data.properties);
  const [drill, setDrill] = useState<(OpenedMark & { target: WidgetTarget }) | null>(null);
  const workspaceId = data.database.workspaceId;
  const rowsPopover = drill && <DrillRows widget={widget} period={period} workspaceId={workspaceId} {...drill} />;

  switch (data.kind) {
    case "number": {
      const fn: AggregateFn = measure.kind === "count" ? "count_all" : measure.fn;
      const value = data.result ? formatResult(fn, data.result, measure.kind === "count" ? undefined : measure.prop.options) : "–";
      return (
        <>
          <NumberFigure
            compact
            value={value}
            label={measureName === title ? undefined : measureName}
            openLabel={td("chart.openRows", { group: measureName, value })}
            onOpen={(anchor) => setDrill({ groupKey: "", title: measureName, value, anchor, target: {}, onClose: () => setDrill(null) })}
          />
          {data.previous && (
            <ChangeLine change={figureChange(data.result, data.previous.result)} comparison={comparisonOf(config)} versus={rangeName(data.previous.range)} />
          )}
          {rowsPopover}
        </>
      );
    }
    case "chart": {
      const groupBy = data.properties.find((p) => p.id === data.groupById);
      const stackBy = data.properties.find((p) => p.id === data.stackById) ?? null;
      if (!data.chart || !groupBy) return <Notice>{t("noGroup")}</Notice>;
      if (data.rowCount === 0) return <Notice>{td("chart.empty")}</Notice>;
      return (
        <>
          <Chart
            workspaceId={workspaceId}
            view={widget.view}
            properties={data.properties}
            groupBy={groupBy}
            stackBy={stackBy}
            measure={measure}
            data={data.chart}
            renderRows={(opened) => (
              <DrillRows
                widget={widget}
                period={period}
                workspaceId={workspaceId}
                {...opened}
                target={{ groupKey: opened.groupKey, ...(opened.seriesKey !== undefined ? { seriesKey: opened.seriesKey } : {}) }}
              />
            )}
          />
          {rowsPopover}
        </>
      );
    }
    case "list":
      if (!data.rows.length) return <Notice>{td("list.empty")}</Notice>;
      return (
        <div className="flex flex-col">
          <RowLinks rows={data.rows} workspaceId={workspaceId} />
          {data.rowCount > data.rows.length && (
            <Link
              href={`/w/${workspaceId}/p/${data.database.id}`}
              className="mt-1 self-start rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              {t("more", { count: data.rowCount - data.rows.length })}
            </Link>
          )}
        </div>
      );
    case "view":
      return (
        <div className="max-h-[32rem] overflow-auto">
          <DatabaseEmbed databaseId={widget.databaseId} linked={readOnlyView} bare />
        </div>
      );
  }
}

function RowLinks({ rows, workspaceId, onClick }: { rows: WidgetRow[]; workspaceId: string; onClick?: () => void }) {
  const tc = useTranslations("common");
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/w/${workspaceId}/p/${row.id}`}
            onClick={onClick}
            className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none"
          >
            <PageIcon icon={row.icon} className="shrink-0" />
            <span className={cn("truncate", !row.title && "text-fg-faint")}>{pageLabel(row.title, tc("untitled"))}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The rows behind a number, bar, point or slice, asked for when it is clicked. */
function DrillRows({
  widget,
  period,
  workspaceId,
  target,
  title,
  value,
  anchor,
  onClose,
}: OpenedMark & { widget: DashboardWidget; period: string; workspaceId: string; target: WidgetTarget }) {
  const t = useTranslations("database.chart");
  const td = useTranslations("page.dashboard");
  const timeZone = useViewerTimeZone();
  const [result, setResult] = useState<{ rows: WidgetRow[]; total: number } | null | "failed">(null);
  const key = JSON.stringify({ databaseId: widget.databaseId, view: widget.view, target });
  useEffect(() => {
    let live = true;
    const { databaseId, view, target } = JSON.parse(key) as { databaseId: string; view: LinkedView; target: WidgetTarget };
    widgetRowsAction({ databaseId, view }, target, timeZone, period)
      .then((res) => live && setResult(res ?? "failed"))
      .catch(() => live && setResult("failed"));
    return () => {
      live = false;
    };
  }, [key, timeZone, period]);
  return (
    <Floating open anchor={anchor} onClose={onClose}>
      <div className="w-72 max-w-[calc(100vw-2rem)]" aria-label={t("rowsIn", { group: title })} role="dialog">
        <div className="px-2 pt-1 pb-1.5">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-xs text-fg-muted">
            {value}
            {result && result !== "failed" && <> · {t("rowCount", { count: result.total })}</>}
          </div>
        </div>
        {result === null && <p className="px-2 pb-2 text-xs text-fg-faint">…</p>}
        {result === "failed" && <p className="px-2 pb-2 text-xs text-danger">{td("loadFailed")}</p>}
        {result && result !== "failed" && (
          <>
            {!result.rows.length && <p className="px-2 pb-2 text-xs text-fg-faint">{t("noRows")}</p>}
            <div className="max-h-72 overflow-y-auto">
              <RowLinks rows={result.rows} workspaceId={workspaceId} onClick={onClose} />
            </div>
            {result.total > result.rows.length && (
              <p className="px-2 pt-1 pb-1.5 text-xs text-fg-faint">{td("more", { count: result.total - result.rows.length })}</p>
            )}
          </>
        )}
      </div>
    </Floating>
  );
}

/** Rules in a view's filters, nested ones included. */
function countRules(entries: FilterEntry[] | undefined): number {
  return (entries ?? []).reduce((sum, e) => sum + ("rules" in e ? countRules(e.rules) : 1), 0);
}

/** What the widget shows, in words, and how fresh it is: "Count · by Status · 2 filters · updated 2 min ago". */
function WidgetFooter({ widget, data, fetchedAt }: { widget: DashboardWidget; data: OkData; fetchedAt: number | null }) {
  const t = useTranslations("page.dashboard");
  const td = useTranslations("database");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const config = widget.view.config;
  const measure = useMemo(() => chartMeasure(config, data.properties), [config, data.properties]);
  const measureName = useMeasureName(measure, data.properties);
  const parts: string[] = [];
  if (data.kind === "number") parts.push(t("rows", { count: data.rowCount }));
  if (data.kind === "chart") {
    const groupBy = data.properties.find((p) => p.id === data.groupById);
    parts.push(measureName);
    if (groupBy) parts.push(t("byGroup", { property: groupBy.name }));
  }
  if (data.kind === "list") parts.push(t("rows", { count: data.rowCount }));
  if (data.kind === "view") parts.push(td(`views.${widget.view.type}`));
  const filters = countRules(config.filters);
  if (filters) parts.push(t("filters", { count: filters }));
  if (data.period) parts.push(data.period.property ? t("period.by", { property: data.period.property.name }) : t("period.ignored"));
  if (fetchedAt) {
    const ago = now.getTime() - fetchedAt;
    parts.push(ago < 45_000 ? t("updatedNow") : t("updated", { time: format.relativeTime(fetchedAt, now) }));
  }
  return <p className="mt-2 truncate text-xs text-fg-faint">{parts.join(" · ")}</p>;
}

function WidgetMenu({ widget, actions }: { widget: DashboardWidget; actions: WidgetActions }) {
  const t = useTranslations("page.dashboard");
  const menu = useFloating<HTMLButtonElement>();
  const run = (action: () => void) => () => {
    menu.close();
    action();
  };
  return (
    <>
      <IconButton ref={menu.ref} label={t("menu")} onClick={menu.toggle} className="ms-auto">
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <div className="w-52">
          <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={run(actions.edit)}>
            {t("edit")}
          </MenuItem>
          <MenuSeparator />
          <div className="px-2 pt-1 pb-1 text-xs text-fg-muted">{t("width")}</div>
          <SpanPicker span={widget.span} onPick={(span) => actions.change({ ...widget, span })} />
          <MenuSeparator />
          <div className="px-2 pt-1 pb-1 text-xs text-fg-muted">{t("color")}</div>
          <ColorPicker
            color={widget.color}
            onPick={(color) => {
              const { color: _, ...rest } = widget;
              actions.change(color ? { ...rest, color } : rest);
            }}
          />
          <MenuSeparator />
          <MenuItem icon={<ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={actions.first} onClick={run(() => actions.move(-1))}>
            {t("moveBefore")}
          </MenuItem>
          <MenuItem icon={<ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={actions.last} onClick={run(() => actions.move(1))}>
            {t("moveAfter")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={run(actions.remove)}>
            {t("remove")}
          </MenuItem>
        </div>
      </Floating>
    </>
  );
}

/** Quarter, half, three quarters or the full width of the dashboard. */
function SpanPicker({ span, onPick }: { span: WidgetSpan; onPick: (span: WidgetSpan) => void }) {
  const t = useTranslations("page.dashboard");
  return (
    <div role="radiogroup" aria-label={t("width")} className="grid grid-cols-4 gap-0.5 px-1 pb-1">
      {WIDGET_SPANS.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={s === span}
          title={t(`widths.${s}`)}
          onClick={() => onPick(s)}
          className={cn(
            "flex h-7 items-center justify-center rounded border text-xs",
            s === span ? "border-accent bg-bg-hover font-medium" : "border-border text-fg-muted hover:bg-bg-hover",
          )}
        >
          {s}/4
        </button>
      ))}
    </div>
  );
}

/** No color, or one of the option palette's hues: swatches as board columns show them. */
function ColorPicker({ color, onPick }: { color: WidgetColor | undefined; onPick: (color: WidgetColor | undefined) => void }) {
  const t = useTranslations("page.dashboard");
  const tColor = useTranslations("database.colors");
  const swatch = (value: WidgetColor | undefined, label: string) => (
    <button
      key={value ?? "none"}
      type="button"
      role="radio"
      aria-checked={value === color}
      aria-label={label}
      title={label}
      onClick={() => value !== color && onPick(value)}
      className={cn(
        "h-6 rounded border",
        value ? `opt-${value} border-fg/10` : "border-border bg-bg",
        value === color && "ring-2 ring-accent ring-offset-1 ring-offset-bg",
      )}
    />
  );
  return (
    <div role="radiogroup" aria-label={t("color")} className="grid grid-cols-5 gap-1 px-2 pb-1.5">
      {swatch(undefined, t("colorNone"))}
      {WIDGET_COLORS.map((c) => swatch(c, tColor(c)))}
    </div>
  );
}

/**
 * Setting a widget up in place: its title and width, what a number or chart measures, the period's
 * date, and its view with the linked view's own toolbar.
 */
function WidgetEditor({ widget, actions, fixed, data }: { widget: DashboardWidget; actions: WidgetActions; fixed: boolean; data: OkData | null }) {
  const t = useTranslations("page.dashboard");
  const tv = useTranslations("database.dashboardView");
  const { change } = actions;
  // The view's own toolbar keeps its handler: the widget and how to change it are read when it fires.
  const latest = useRef({ widget, change });
  latest.current = { widget, change };
  const linked = useMemo(
    () => ({ view: widget.view, onChange: (view: LinkedView) => latest.current.change({ ...latest.current.widget, view }) }),
    [widget.view],
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={widget.title}
          maxLength={MAX_WIDGET_TITLE}
          onChange={(e) => change({ ...widget, title: e.target.value })}
          placeholder={fixed ? tv("titlePlaceholder") : t("titlePlaceholder")}
          aria-label={t("titleLabel")}
          className="h-8 min-w-40 flex-1"
        />
        <div className="w-44">
          <SpanPicker span={widget.span} onPick={(span) => change({ ...widget, span })} />
        </div>
        <Button size="sm" onClick={actions.done}>
          {t("done")}
        </Button>
      </div>
      {data && widget.view.type === "chart" && <MeasureSettings widget={widget} measurable={data.measurable} onChange={change} />}
      {data && <PeriodSettings widget={widget} dateProperties={data.dateProperties} onChange={change} />}
      <DatabaseEmbed databaseId={widget.databaseId} linked={linked} />
    </div>
  );
}

/**
 * What a number or chart measures, the same setting its view's chart settings hold, kept in sight
 * beside the title: counting rows, or a calculation over one property. A widget left without a
 * title is named after it, so the name follows.
 */
function MeasureSettings({
  widget,
  measurable,
  onChange,
}: {
  widget: DashboardWidget;
  measurable: OkData["measurable"];
  onChange: (widget: DashboardWidget) => void;
}) {
  const t = useTranslations("database");
  const config = widget.view.config;
  const agg = config.chartAggregate;
  const prop = agg && measurable.find((p) => p.id === agg.propertyId);
  // A calculation the property no longer offers counts rows, as lib/chart chartMeasure reads it.
  const current = prop && prop.fns.includes(agg.fn) ? { prop, fn: agg.fn } : null;
  const set = (chartAggregate: { fn: AggregateFn; propertyId: string } | undefined) => {
    const { chartAggregate: _, ...rest } = config;
    onChange({ ...widget, view: { ...widget.view, config: chartAggregate ? { ...rest, chartAggregate } : rest } });
  };
  const setProperty = (id: string) => {
    const next = measurable.find((p) => p.id === id);
    // Numbers are summed and checkboxes counted by default; other types count their values.
    set(next && { fn: next.fns.includes("sum") ? "sum" : next.fns[0], propertyId: next.id });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <label className="flex items-center gap-2 text-fg-muted">
        {t("chart.measure")}
        <select className={selectClass} value={current?.prop.id ?? ""} onChange={(e) => setProperty(e.target.value)}>
          <option value="">{t("chart.count")}</option>
          {measurable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <label className="flex items-center gap-2 text-fg-muted">
          {t("chart.calculation")}
          <select className={selectClass} value={current.fn} onChange={(e) => set({ fn: e.target.value as AggregateFn, propertyId: current.prop.id })}>
            {current.prop.fns.map((fn) => (
              <option key={fn} value={fn}>
                {t(`calculate.menu.${fn}`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Which date the dashboard's period cuts a widget's rows on, and how a number compares with the period before. */
function PeriodSettings({
  widget,
  dateProperties,
  onChange,
}: {
  widget: DashboardWidget;
  dateProperties: OkData["dateProperties"];
  onChange: (widget: DashboardWidget) => void;
}) {
  const t = useTranslations("page.dashboard.period");
  const config = widget.view.config;
  const fallback = periodProperty(dateProperties, undefined);
  const set = (key: "periodBy" | "comparison", value: string | undefined) => {
    const { [key]: _, ...rest } = config;
    onChange({ ...widget, view: { ...widget.view, config: value === undefined ? rest : { ...rest, [key]: value } } });
  };
  const isNumber = widget.view.type === "chart" && config.chartType === "number";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <label className="flex items-center gap-2 text-fg-muted">
        {t("periodBy")}
        <select className={selectClass} value={config.periodBy ?? ""} onChange={(e) => set("periodBy", e.target.value || undefined)}>
          <option value="">{fallback ? t("byDefault", { property: fallback.name }) : t("noDate")}</option>
          {dateProperties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {config.periodBy && config.periodBy !== PERIOD_NONE && !dateProperties.some((p) => p.id === config.periodBy) && (
            <option value={config.periodBy}>{t("unknownProperty")}</option>
          )}
          <option value={PERIOD_NONE}>{t("none")}</option>
        </select>
      </label>
      {isNumber && (
        <label className="flex items-center gap-2 text-fg-muted">
          {t("comparison")}
          <select
            className={selectClass}
            value={comparisonOf(config)}
            onChange={(e) => set("comparison", e.target.value === "higher" ? undefined : (e.target.value as Comparison))}
          >
            {COMPARISONS.map((c) => (
              <option key={c} value={c}>
                {t(`comparisons.${c}`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 rounded-md bg-bg-subtle px-3 py-2 text-sm text-fg-muted">{children}</div>;
}

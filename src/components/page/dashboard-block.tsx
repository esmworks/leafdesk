"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { ArrowLeft, ArrowRight, Lock, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { widgetDataAction, widgetRowsAction, widgetStampsAction } from "@/app/actions/dashboards";
import { useChannel } from "@/components/collab/use-channel";
import { Chart, NumberFigure, useMeasureName, type OpenedMark } from "@/components/database/chart-view";
import { Floating, useFloating } from "@/components/database/floating";
import { useFormatResult } from "@/components/database/table-calculations";
import { useViewerTimeZone } from "@/components/database/use-today";
import { Button, cn, IconButton, Input, MenuItem, MenuSeparator, PageIcon, pageLabel } from "@/components/ui";
import type { FilterEntry } from "@/db/schema/app";
import type { AggregateFn } from "@/lib/aggregate";
import { chartMeasure } from "@/lib/chart";
import {
  dashboardBlockConfig,
  dashboardDatabaseIds,
  MAX_WIDGET_TITLE,
  MAX_WIDGETS,
  moveWidget,
  newWidget,
  parseDashboard,
  serializeDashboard,
  updateWidget,
  WIDGET_SPANS,
  type DashboardWidget,
  type WidgetSpan,
  newWidgetId,
  staleWidgets,
  widgetStamp,
  DASHBOARD_CLASS,
  DASHBOARD_GRID_CLASS,
  WIDGET_SPAN_CLASS,
} from "@/lib/dashboard";
import type { LinkedView } from "@/lib/embed-blocks";
import type { WidgetData, WidgetRow, WidgetTarget } from "@/server/dashboards";
import { DatabaseEmbed, useEmbedHost } from "./database-embed";
import { DatabasePicker } from "./database-picker";

/**
 * The dashboard block (see lib/dashboard): widgets in a grid, each a view of a database the reader
 * may see. Numbers, charts and lists come worked out from the server (server/dashboards) and are
 * asked for again when their database changes (its rows, or how the reader sees it); other layouts
 * are linked views. Editors set a widget up in place, with the linked view's own toolbar.
 */
export const DashboardBlock = createReactBlockSpec(dashboardBlockConfig, {
  meta: { selectable: false },
  render: function DashboardBlockView({ block, editor }) {
    const host = useEmbedHost();
    const widgets = useMemo(() => parseDashboard(block.props.widgets), [block.props.widgets]);
    // The widgets live in the block, so they sync, undo and version with the page. Readers who
    // can't edit the page can't change them (the collab server would drop the edit anyway).
    const editable = host?.editable ?? false;
    const onChange = useMemo(
      () =>
        editable
          ? (next: DashboardWidget[]) => {
              if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { widgets: serializeDashboard(next) } });
            }
          : undefined,
      [editable, editor, block.id],
    );
    return <Dashboard widgets={widgets} onChange={onChange} />;
  },
  toExternalHTML: () => <div />,
});

function Dashboard({ widgets, onChange }: { widgets: DashboardWidget[]; onChange?: (widgets: DashboardWidget[]) => void }) {
  const t = useTranslations("page.dashboard");
  const host = useEmbedHost();
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const full = widgets.length >= MAX_WIDGETS;
  const shown = useRef(new Map<string, ShownWidget>());
  useTreeRefresh(host?.workspaceId ?? null, shown);

  const add = (databaseId: string) => {
    setPicking(false);
    if (!onChange || full) return;
    const widget = newWidget(newWidgetId(widgets), databaseId);
    onChange([...widgets, widget]);
    setEditing(widget.id);
  };

  const addButton = onChange && (
    <Button size="sm" variant="ghost" onClick={() => setPicking(true)} disabled={full} title={full ? t("full", { max: MAX_WIDGETS }) : undefined}>
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
            <p className="mt-0.5 text-sm text-fg-muted">{onChange ? t("emptyEditable") : t("empty")}</p>
          </div>
          {addButton}
        </div>
      ) : (
        <>
          <div className={DASHBOARD_GRID_CLASS}>
            {widgets.map((widget, index) => (
              <Widget
                key={widget.id}
                widget={widget}
                shown={shown}
                editing={editing === widget.id}
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
      {host && onChange && <DatabasePicker open={picking} workspaceId={host.workspaceId} onPick={add} onClose={() => setPicking(false)} />}
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
function useWidgetData(widget: DashboardWidget, shown: RefObject<Map<string, ShownWidget>>) {
  const timeZone = useViewerTimeZone();
  const [data, setData] = useState<WidgetData | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const { id, databaseId, view } = widget;
  const key = JSON.stringify({ databaseId, view });
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    try {
      const next = await widgetDataAction(JSON.parse(key) as { databaseId: string; view: LinkedView }, timeZone);
      if (n !== asked.current) return;
      setData(next);
      setFailed(false);
      setFetchedAt(Date.now());
    } catch {
      if (n === asked.current) setFailed(true);
    }
  }, [key, timeZone]);
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
  useChannel(`db:${databaseId}`, later);

  const stamp = data && !failed ? widgetStamp(data.state === "ok" ? data.database : null) : null;
  useEffect(() => {
    const map = shown.current;
    map.set(id, { databaseId, stamp, reload: load });
    return () => void map.delete(id);
  }, [shown, id, databaseId, stamp, load]);

  return { data, failed, fetchedAt, retry: load };
}

function Widget({
  widget,
  shown,
  editing,
  actions,
}: {
  widget: DashboardWidget;
  shown: RefObject<Map<string, ShownWidget>>;
  editing: boolean;
  actions?: WidgetActions;
}) {
  const t = useTranslations("page.dashboard");
  const tc = useTranslations("common");
  const { data, failed, fetchedAt, retry } = useWidgetData(widget, shown);
  const ok = data?.state === "ok" ? data : null;
  const title = widget.title || (ok ? pageLabel(ok.database.title, tc("untitled")) : "");
  const href = ok ? `/w/${ok.database.workspaceId}/p/${ok.database.id}` : null;

  let body: ReactNode;
  if (editing && actions) body = <WidgetEditor widget={widget} actions={actions} />;
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
  } else body = <WidgetBody widget={widget} data={data} />;

  return (
    <section
      aria-label={title || undefined}
      className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-bg p-3", WIDGET_SPAN_CLASS[editing ? 4 : widget.span])}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-1.5">
        {ok && <PageIcon icon={ok.database.icon} kind="database" className="text-sm" />}
        {href ? (
          <Link href={href} className="min-w-0 truncate text-sm font-medium hover:underline">
            {title}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        )}
        {actions && !editing && <WidgetMenu widget={widget} actions={actions} />}
      </div>
      <div className="mt-2 min-h-0 min-w-0 flex-1">{body}</div>
      {!editing && ok && !ok.database.inTrash && <WidgetFooter widget={widget} data={ok} fetchedAt={fetchedAt} />}
    </section>
  );
}

type OkData = Extract<WidgetData, { state: "ok" }>;

function WidgetBody({ widget, data }: { widget: DashboardWidget; data: OkData }) {
  const t = useTranslations("page.dashboard");
  const td = useTranslations("database");
  const formatResult = useFormatResult();
  const config = widget.view.config;
  const readOnlyView = useMemo(() => ({ view: widget.view }), [widget.view]);
  const measure = useMemo(() => chartMeasure(config, data.properties), [config, data.properties]);
  const measureName = useMeasureName(measure, data.properties);
  const [drill, setDrill] = useState<(OpenedMark & { target: WidgetTarget }) | null>(null);
  const workspaceId = data.database.workspaceId;
  const rowsPopover = drill && <DrillRows widget={widget} workspaceId={workspaceId} {...drill} />;

  switch (data.kind) {
    case "number": {
      const fn: AggregateFn = measure.kind === "count" ? "count_all" : measure.fn;
      const value = data.result ? formatResult(fn, data.result, measure.kind === "count" ? undefined : measure.prop.options) : "–";
      return (
        <>
          <NumberFigure
            compact
            value={value}
            label={measureName}
            openLabel={td("chart.openRows", { group: measureName, value })}
            onOpen={(anchor) => setDrill({ groupKey: "", title: measureName, value, anchor, target: {}, onClose: () => setDrill(null) })}
          />
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
  workspaceId,
  target,
  title,
  value,
  anchor,
  onClose,
}: OpenedMark & { widget: DashboardWidget; workspaceId: string; target: WidgetTarget }) {
  const t = useTranslations("database.chart");
  const td = useTranslations("page.dashboard");
  const timeZone = useViewerTimeZone();
  const [result, setResult] = useState<{ rows: WidgetRow[]; total: number } | null | "failed">(null);
  const key = JSON.stringify({ databaseId: widget.databaseId, view: widget.view, target });
  useEffect(() => {
    let live = true;
    const { databaseId, view, target } = JSON.parse(key) as { databaseId: string; view: LinkedView; target: WidgetTarget };
    widgetRowsAction({ databaseId, view }, target, timeZone)
      .then((res) => live && setResult(res ?? "failed"))
      .catch(() => live && setResult("failed"));
    return () => {
      live = false;
    };
  }, [key, timeZone]);
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
      <IconButton ref={menu.ref} label={t("menu")} onClick={menu.toggle} className="ml-auto">
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
          <MenuItem icon={<ArrowLeft className="h-3.5 w-3.5" />} disabled={actions.first} onClick={run(() => actions.move(-1))}>
            {t("moveBefore")}
          </MenuItem>
          <MenuItem icon={<ArrowRight className="h-3.5 w-3.5" />} disabled={actions.last} onClick={run(() => actions.move(1))}>
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

/** Setting a widget up in place: its title and width, and its view with the linked view's own toolbar. */
function WidgetEditor({ widget, actions }: { widget: DashboardWidget; actions: WidgetActions }) {
  const t = useTranslations("page.dashboard");
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
          placeholder={t("titlePlaceholder")}
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
      <DatabaseEmbed databaseId={widget.databaseId} linked={linked} />
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 rounded-md bg-bg-subtle px-3 py-2 text-sm text-fg-muted">{children}</div>;
}

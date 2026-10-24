"use client";

import { ArrowLeft, ArrowRight, Lock, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { widgetStampsAction } from "@/app/actions/dashboards";
import { useChannel } from "@/components/collab/use-channel";
import { Floating, useFloating } from "@/components/database/floating";
import { isRtl } from "@/components/direction";
import { useReorderDrag, type ReorderDragHandlers } from "@/components/use-reorder-drag";
import { Button, cn, IconButton, Input, MenuItem, MenuSeparator, PageIcon, pageLabel } from "@/components/ui";
import {
  dashboardDatabaseIds,
  MAX_WIDGET_TITLE,
  MAX_WIDGETS,
  moveWidget,
  newTab,
  newWidgetId,
  placeWidget,
  stampHeader,
  updateWidget,
  type DashboardWidget,
  type WidgetDatabaseHeader,
} from "@/lib/dashboard";
import type { LinkedView } from "@/lib/embed-blocks";
import { DatabaseEmbed } from "./database-embed";
import { DatabasePicker } from "./database-picker";

/**
 * A dashboard block laid out as tabs (lib/dashboard, `layout` "tabs"): one widget at a time, each a
 * linked view of a database named on its tab. Readers get only the tabs whose database they can
 * open, asked for in one request (server/dashboards widgetStamps) and again when the workspace's
 * page tree changes; editors get every tab, so they can take out one that lost its database. The
 * open tab is the reader's own and isn't saved: everyone starts at the first.
 */
/** What a dragged tab carries: not text, so the editor around the tabs leaves the drop alone. */
const TAB_DRAG_TYPE = "application/x-leafdesk-tab";

type Headers = Record<string, WidgetDatabaseHeader>;

export function DashboardTabs({
  widgets,
  onChange,
  workspaceId,
}: {
  widgets: DashboardWidget[];
  /** Only for those who may change the tabs. */
  onChange?: (widgets: DashboardWidget[]) => void;
  workspaceId: string | null;
}) {
  const t = useTranslations("page.databaseTabs");
  const td = useTranslations("page.dashboard");
  const tc = useTranslations("common");
  const headers = useTabHeaders(workspaceId, widgets);
  const [chosen, setChosen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const full = widgets.length >= MAX_WIDGETS;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const drag = useReorderDrag("x", (moved, target, side) => onChange?.(placeWidget(widgets, moved, target, side)), TAB_DRAG_TYPE);

  // Until it is known which databases the reader can open ("unknown" when that couldn't be asked,
  // and then each tab's view says so itself), readers see no tabs.
  const tabs = useMemo(
    () => (onChange || headers === "unknown" ? widgets : headers ? widgets.filter((w) => headers[w.databaseId]) : []),
    [onChange, headers, widgets],
  );
  const active = tabs.find((w) => w.id === chosen) ?? tabs[0];

  // The view's own toolbar keeps its handler: the tabs and how to change them are read when it fires.
  const latest = useRef({ widgets, onChange });
  latest.current = { widgets, onChange };
  const activeId = active?.id;
  const activeView = active?.view;
  const linked = useMemo(
    () =>
      activeView && {
        view: activeView,
        onChange: onChange
          ? (view: LinkedView) => {
              const { widgets: list, onChange: change } = latest.current;
              change?.(updateWidget(list, activeId!, (w) => ({ ...w, view })));
            }
          : undefined,
      },
    [activeId, activeView, onChange],
  );

  const add = (databaseId: string) => {
    setPicking(false);
    if (!onChange || full) return;
    const tab = newTab(newWidgetId(widgets), databaseId);
    onChange([...widgets, tab]);
    setChosen(tab.id);
  };
  const select = (id: string) => {
    setChosen(id);
    tabRefs.current.get(id)?.focus();
  };
  // Arrow keys go from tab to tab (in reading order, right to left too), Home and End to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!active || renaming) return;
    const at = tabs.indexOf(active);
    const back = isRtl(e.currentTarget) ? "ArrowRight" : "ArrowLeft";
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : e.key === back ? at - 1 : e.key === "ArrowLeft" || e.key === "ArrowRight" ? at + 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length].id);
  };

  const addButton = onChange && (
    <Button size="sm" variant="ghost" onClick={() => setPicking(true)} disabled={full} title={full ? t("full", { max: MAX_WIDGETS }) : undefined}>
      <Plus className="h-3.5 w-3.5" />
      {t("add")}
    </Button>
  );
  const picker = workspaceId && onChange && (
    <DatabasePicker open={picking} workspaceId={workspaceId} onPick={add} onClose={() => setPicking(false)} />
  );

  if (!widgets.length || (!onChange && headers && !tabs.length)) {
    return (
      <div className="my-2 w-full min-w-0" contentEditable={false}>
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
          <div>
            <p className="text-sm font-medium">{t("title")}</p>
            <p className="mt-0.5 text-sm text-fg-muted">{widgets.length ? td("unavailable") : onChange ? t("emptyEditable") : t("empty")}</p>
          </div>
          {addButton}
        </div>
        {picker}
      </div>
    );
  }
  if (!active) {
    return (
      <div className="my-2 w-full min-w-0" contentEditable={false}>
        <div aria-busy="true" aria-label={tc("loading")} className="h-32 animate-pulse rounded-md bg-bg-subtle" />
      </div>
    );
  }

  const known = headers && headers !== "unknown" ? headers : null;
  const tabId = (id: string) => `tab-${id}`;
  const panelId = (id: string) => `tab-panel-${id}`;
  return (
    <div className="database-tabs my-2 w-full min-w-0" contentEditable={false}>
      <div className="flex min-w-0 items-end gap-1 border-b border-border">
        <div role="tablist" aria-label={t("title")} onKeyDown={onKeyDown} className="flex min-w-0 items-end gap-0.5 overflow-x-auto">
          {tabs.map((widget, index) => (
            <Tab
              key={widget.id}
              ref={(el) => void (el ? tabRefs.current.set(widget.id, el) : tabRefs.current.delete(widget.id))}
              widget={widget}
              header={known ? (known[widget.databaseId] ?? null) : undefined}
              selected={widget.id === active.id}
              id={tabId(widget.id)}
              controls={panelId(widget.id)}
              onSelect={() => setChosen(widget.id)}
              renaming={renaming === widget.id}
              drag={onChange && renaming !== widget.id ? drag.handlers(widget.id) : undefined}
              actions={
                onChange && {
                  first: index === 0,
                  last: index === tabs.length - 1,
                  rename: () => setRenaming(widget.id),
                  renamed: (title) => {
                    setRenaming(null);
                    if (title !== null) onChange(updateWidget(widgets, widget.id, (w) => ({ ...w, title: title.slice(0, MAX_WIDGET_TITLE) })));
                  },
                  move: (by) => onChange(moveWidget(widgets, widget.id, by)),
                  remove: () => {
                    if (renaming === widget.id) setRenaming(null);
                    onChange(updateWidget(widgets, widget.id, () => null));
                  },
                }
              }
            />
          ))}
        </div>
        {onChange && (
          <IconButton label={t("add")} onClick={() => setPicking(true)} disabled={full} title={full ? t("full", { max: MAX_WIDGETS }) : t("add")} className="mb-1 shrink-0">
            <Plus className="h-4 w-4" />
          </IconButton>
        )}
      </div>
      <div role="tabpanel" id={panelId(active.id)} aria-labelledby={tabId(active.id)} className="min-w-0 pt-2">
        {linked && <DatabaseEmbed key={active.id} databaseId={active.databaseId} linked={linked} />}
      </div>
      {picker}
    </div>
  );
}

type TabActions = {
  first: boolean;
  last: boolean;
  rename: () => void;
  /** The new name, or null to keep the old one. */
  renamed: (title: string | null) => void;
  move: (by: number) => void;
  remove: () => void;
};

function Tab({
  ref,
  widget,
  header,
  selected,
  id,
  controls,
  onSelect,
  renaming,
  drag,
  actions,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  widget: DashboardWidget;
  /** Its database as the reader sees it: null when they can't, undefined while that isn't known. */
  header: WidgetDatabaseHeader | undefined;
  selected: boolean;
  id: string;
  controls: string;
  onSelect: () => void;
  renaming: boolean;
  /** Editors move a tab by dragging it onto another. */
  drag?: ReorderDragHandlers;
  actions?: TabActions;
}) {
  const t = useTranslations("page.databaseTabs");
  const tc = useTranslations("common");
  const name = widget.title || (header ? pageLabel(header.title, tc("untitled")) : header === null ? t("noAccess") : "");

  if (renaming && actions) {
    return (
      <Input
        autoFocus
        defaultValue={widget.title}
        maxLength={MAX_WIDGET_TITLE}
        placeholder={header ? pageLabel(header.title, tc("untitled")) : t("namePlaceholder")}
        aria-label={t("nameLabel")}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") actions.renamed(e.currentTarget.value.trim());
          else if (e.key === "Escape") actions.renamed(null);
        }}
        onBlur={(e) => actions.renamed(e.currentTarget.value.trim())}
        className="mb-1 h-7 w-44"
      />
    );
  }
  return (
    <div
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={cn(
        "relative -mb-px flex shrink-0 items-center border-b-2",
        selected ? "border-accent" : "border-transparent",
        drag?.dragging && "opacity-50",
      )}
    >
      {drag?.dropSide && (
        <div aria-hidden className={cn("pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded bg-accent", drag.dropSide === "before" ? "-inset-s-px" : "-inset-e-px")} />
      )}
      <button
        ref={ref}
        type="button"
        role="tab"
        id={id}
        aria-selected={selected}
        aria-controls={selected ? controls : undefined}
        tabIndex={selected ? 0 : -1}
        draggable={!!drag}
        onDragStart={drag?.onDragStart}
        onDragEnd={drag?.onDragEnd}
        onClick={onSelect}
        onDoubleClick={actions?.rename}
        className={cn(
          "flex max-w-56 min-w-0 items-center gap-1.5 rounded-t px-2.5 py-1.5 text-sm hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent",
          selected ? "font-medium text-fg" : "text-fg-muted hover:text-fg",
          drag && "cursor-grab active:cursor-grabbing",
        )}
      >
        {header === null ? <Lock className="h-3.5 w-3.5 shrink-0" /> : header && <PageIcon icon={header.icon} kind="database" className="text-sm" />}
        {name ? <span className="truncate">{name}</span> : <span aria-hidden className="h-3 w-16 animate-pulse rounded bg-bg-subtle" />}
      </button>
      {selected && actions && <TabMenu actions={actions} />}
    </div>
  );
}

function TabMenu({ actions }: { actions: TabActions }) {
  const t = useTranslations("page.databaseTabs");
  const td = useTranslations("page.dashboard");
  const menu = useFloating<HTMLButtonElement>();
  const run = (action: () => void) => () => {
    menu.close();
    action();
  };
  return (
    <>
      <IconButton ref={menu.ref} label={t("menu")} onClick={menu.toggle}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <div className="w-48">
          <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={run(actions.rename)}>
            {t("rename")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={actions.first} onClick={run(() => actions.move(-1))}>
            {td("moveBefore")}
          </MenuItem>
          <MenuItem icon={<ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={actions.last} onClick={run(() => actions.move(1))}>
            {td("moveAfter")}
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

/**
 * The tabs' databases as the reader sees them, by id (null for one they can't open), asked for again
 * shortly after the workspace's page tree changes (sharing, moving, trashing, renaming). Null while
 * the first answer is on its way, "unknown" when it couldn't be had.
 */
function useTabHeaders(workspaceId: string | null, widgets: DashboardWidget[]): Headers | "unknown" | null {
  const ids = dashboardDatabaseIds(widgets).join(",");
  const [headers, setHeaders] = useState<Headers | "unknown" | null>(null);
  const asked = useRef(0);
  const load = useCallback(async () => {
    const n = ++asked.current;
    const list = ids ? ids.split(",") : [];
    const stamps = list.length ? await widgetStampsAction(list).catch(() => null) : {};
    if (n !== asked.current) return;
    if (!stamps) return setHeaders((current) => (current && current !== "unknown" ? current : "unknown"));
    const next: Headers = Object.fromEntries(list.map((id) => [id, stampHeader(stamps[id])]));
    setHeaders((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [ids]);
  useEffect(() => {
    void load();
  }, [load]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(workspaceId ? `ws:${workspaceId}` : null, (event) => {
    if (event !== "tree") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 300);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return headers;
}

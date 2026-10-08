"use client";

import { ChevronRight, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Button, cn, PageIcon } from "@/components/ui";
import { useMediaQuery } from "@/components/use-media-query";
import type { TimelineZoom } from "@/db/schema/app";
import { pageLabel } from "@/lib/labels";
import { canAddToGroup, groupDefaults, groupRowsBy, type Group } from "@/lib/grouping";
import { isHiddenInView, localDay, statusColor } from "@/lib/properties";
import { isComputed } from "@/lib/property-types";
import {
  DAY_WIDTH,
  dayAtX,
  dayDate,
  dayValue,
  dayX,
  dragDays,
  dragSpan,
  headerUnits,
  rowSpan,
  spanValues,
  timelineRange,
  today as todayNumber,
  type DaySpan,
  type DragMode,
} from "@/lib/timeline";
import { TIMELINE_ZOOMS } from "@/lib/views";
import type { SubItemLine } from "@/lib/sub-items";
import { blockedByProperty, storedBlockers } from "@/lib/dependencies";
import { CardTitleInput } from "./board-view";
import { AddSubItemButton, SUB_ITEM_INDENT, SubItemCount, SubItemToggle, useSubItems } from "./sub-items";
import { usePeople } from "./person-cell";
import { GroupLabel, useGroupContext, useGroupName } from "./group-label";
import { PropertyLock, usePropertyAccess } from "./property-access";
import { RowValue, shownValues } from "./property-cell";
import { useNewRow } from "./use-new-row";
import { TITLE, type Property, type Row, type View } from "./types";
import type { DatabaseApi } from "./use-database";
import { timelineDates, timelineGroupProperty } from "./view-settings";

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 48;
/** Room for the title column of the table, and for each property it shows. */
const TITLE_WIDTH = { wide: 240, narrow: 140 };
const PROP_WIDTH = 120;
const MAX_TABLE_PROPS = 2;
/** Pointer travel before a press on a bar counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Bars narrower than this show their title beside them instead of inside. */
const MIN_LABEL_WIDTH = 72;

type Drag = { rowId: string; mode: DragMode; originX: number; days: number; moved: boolean };
/** Dragging from a bar's link handle: the pointer (in track coordinates) and the row under it. */
type Link = { fromId: string; x: number; y: number; targetId: string | null };
/** How far a dependency arrow runs out of a bar before it turns. */
const ARROW_GAP = 8;

/** The bar color of a swimlane: its option's, or its status stage's; plain cards otherwise. */
function laneColor(group: Group<Row> | null) {
  if (group?.value.kind === "option") return group.value.option.color;
  if (group?.value.kind === "status_group") return statusColor(group.value.group);
  return null;
}

export function TimelineView({
  workspaceId,
  view,
  properties,
  rows,
  allRows = rows,
  api,
  readOnly,
  locked,
  onCreateDateProperty,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  /** Every row the viewer sees, the view's filters aside: whether a row has a parent is read there. */
  allRows?: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  locked?: boolean;
  onCreateDateProperty: () => void;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const { viewerId } = usePeople();
  const narrow = useMediaQuery("(max-width: 640px)");
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // The config holds the saved zoom and table setting; viewers who can't save still switch locally.
  const [localZoom, setLocalZoom] = useState<TimelineZoom | null>(null);
  const [localTable, setLocalTable] = useState<boolean | null>(null);
  const zoom = localZoom ?? view.config.zoom ?? "week";
  const showTable = localTable ?? view.config.showTable !== false;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropDay, setDropDay] = useState<number | null>(null);
  const [dragUndated, setDragUndated] = useState<string | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const { editTitleOf, typed, create: createNew, stopEditing } = useNewRow((id, title) => void api.setCell(id, TITLE, title));
  const [showUndated, setShowUndated] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // The day to bring into view after the next layout, and where (a share of the visible width).
  const pendingFocus = useRef<{ day: number; at: number } | null>(null);
  const suppressClick = useRef(false);
  const today = todayNumber();

  const { start: startProp, end: endProp } = timelineDates(view, properties);
  const groupBy = timelineGroupProperty(view, properties);
  const groupContext = useGroupContext(groupBy ?? undefined);
  const groupName = useGroupName(groupBy ?? { name: "" });
  // Created and edited times place bars but can't be changed by dragging them.
  const movable = !readOnly && !!startProp && !isComputed(startProp.type);
  const resizable = movable && !!endProp;
  // Property access: a bar moves only where the viewer may change its dates in that row.
  const access = usePropertyAccess();
  const canMove = (row: Row) =>
    movable &&
    access.valueAccess(row, startProp.id) === "edit" &&
    (!endProp || access.valueAccess(row, endProp.id) === "edit");
  // An undated row gets only a start.
  const canPlace = (row: Row) => movable && access.valueAccess(row, startProp.id) === "edit";
  // Dependencies: arrows from each row to the rows waiting for it; dragging from a bar's handle
  // onto another row makes that row wait for it.
  const blockedBy = blockedByProperty(properties);
  const canLinkFrom = !readOnly && !!blockedBy && access.canEditValues(blockedBy.id);
  const canLinkTo = (row: Row) => !!blockedBy && !readOnly && access.valueAccess(row, blockedBy.id) === "edit";
  const tableProps = properties
    .filter((p) => p.id !== startProp?.id && p.id !== endProp?.id && !isHiddenInView(view, p))
    .slice(0, narrow ? 0 : MAX_TABLE_PROPS);
  const panelWidth = showTable ? (narrow ? TITLE_WIDTH.narrow : TITLE_WIDTH.wide + tableProps.length * PROP_WIDTH) : 0;

  const spans = useMemo(() => {
    const map = new Map<string, DaySpan>();
    if (!startProp) return map;
    for (const row of rows) {
      const span = rowSpan(row.properties, startProp, endProp);
      if (span) map.set(row.id, span);
    }
    return map;
  }, [rows, startProp, endProp]);
  const dated = useMemo(() => rows.filter((r) => spans.has(r.id)), [rows, spans]);
  const undated = useMemo(() => rows.filter((r) => !spans.has(r.id)), [rows, spans]);
  const range = useMemo(() => timelineRange([...spans.values()], today, zoom), [spans, today, zoom]);
  const header = useMemo(() => headerUnits(range, zoom), [range, zoom]);
  const width = (range.end - range.start + 1) * DAY_WIDTH[zoom];

  // Swimlanes group like boards and tables do; a row with several tags, people or links shows in
  // each of their lanes. Lanes without bars are left out.
  // Sub-items nest under their parent within each lane; without the table there are no arrows to
  // open them, so all of them show.
  const subItems = useSubItems(view, properties, allRows);
  const linesOf = subItems.lines;
  const lanes = useMemo(() => {
    const lines = (rows: Row[]) => linesOf(rows, { allOpen: !showTable });
    if (!groupBy) return [{ key: "", group: null as Group<Row> | null, rows: dated, lines: lines(dated) }];
    return groupRowsBy(dated, groupBy, view.config, groupContext)
      .filter((g) => g.rows.length)
      .map((g) => ({ key: g.key, group: g as Group<Row> | null, rows: g.rows, lines: lines(g.rows) }));
  }, [groupBy, dated, view.config, groupContext, linesOf, showTable]);

  const trackWidth = () => (scroller.current?.clientWidth ?? 0) - panelWidth;
  const focusOn = (day: number, at: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, dayX(day, range, zoom) - trackWidth() * at);
  };
  // Opens on today; after a zoom change the day that was in the middle stays there.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!scroller.current) return;
    const focus = focused.current ? pendingFocus.current : { day: today, at: 1 / 3 };
    focused.current = true;
    pendingFocus.current = null;
    if (focus) focusOn(focus.day, focus.at);
  });

  if (!startProp) {
    return (
      <div className="page-gutter">
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
          <div>
            <p className="text-sm font-medium">{t("timeline.needsDateTitle")}</p>
            <p className="mt-1 text-sm text-fg-muted">{t("timeline.needsDateBody")}</p>
          </div>
          {!readOnly && !locked && (
            <Button size="sm" onClick={onCreateDateProperty}>
              <Plus className="h-3.5 w-3.5" />
              {t("calendar.addDateProperty", { name: t("calendar.defaultDateProperty") })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const setZoom = (next: TimelineZoom) => {
    if (next === zoom) return;
    const el = scroller.current;
    const centre = el ? dayAtX(el.scrollLeft + trackWidth() / 2, range, zoom) : today;
    pendingFocus.current = { day: centre, at: 1 / 2 };
    if (readOnly) setLocalZoom(next);
    else {
      setLocalZoom(null);
      void api.updateView(view, { config: { ...view.config, zoom: next } });
    }
  };
  const toggleTable = () => {
    if (readOnly) setLocalTable(!showTable);
    else {
      setLocalTable(null);
      void api.updateView(view, { config: { ...view.config, showTable: !showTable } });
    }
  };

  const open = (row: Row) => router.push(`/w/${workspaceId}/p/${row.id}`);

  const commit = (row: Row, next: DaySpan) => {
    const before = spans.get(row.id);
    if (!before) return;
    const values = spanValues(before, next, startProp.id, endProp ? { id: endProp.id, hasValue: row.properties[endProp.id] != null } : null);
    if (Object.keys(values).length) void api.setRowValues(row.id, values);
  };

  const onBarPointerDown = (e: PointerEvent<HTMLElement>, row: Row, mode: DragMode) => {
    suppressClick.current = false;
    // Touch keeps scrolling the timeline; bars open on tap. Drags are for mouse and pen.
    if (!canMove(row) || e.button !== 0 || e.pointerType === "touch") return;
    if (mode !== "move" && !resizable) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ rowId: row.id, mode, originX: e.clientX, days: 0, moved: false });
  };
  const onBarPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const moved = drag.moved || Math.abs(dx) >= DRAG_THRESHOLD;
    const days = moved ? dragDays(dx, zoom) : 0;
    if (days !== drag.days || moved !== drag.moved) setDrag({ ...drag, days, moved });
  };
  const onBarPointerUp = (row: Row) => {
    if (!drag) return;
    const span = spans.get(row.id);
    if (drag.moved) {
      suppressClick.current = true;
      if (span && drag.days) commit(row, dragSpan(span, drag.mode, drag.days));
    }
    setDrag(null);
  };
  const onBarKeyDown = (e: KeyboardEvent<HTMLElement>, row: Row) => {
    if (e.key === "Enter") open(row);
    // Alt+arrows move a bar by a day, for keyboards.
    if (canMove(row) && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const span = spans.get(row.id);
      if (span) commit(row, dragSpan(span, "move", e.key === "ArrowLeft" ? -1 : 1));
    }
  };

  // Undated rows are dragged onto a day of the timeline (desktop drag and drop).
  const dayAtPointer = (clientX: number) => {
    const rect = body.current?.getBoundingClientRect();
    const view = scroller.current?.getBoundingClientRect();
    // Over the (sticky) table there is no day to drop on.
    if (!rect || !view || clientX < view.left + panelWidth) return null;
    return dayAtX(clientX - rect.left - panelWidth, range, zoom);
  };
  const onTimelineDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragUndated) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const day = dayAtPointer(e.clientX);
    if (day !== dropDay) setDropDay(day);
  };
  const onTimelineDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragUndated) return;
    e.preventDefault();
    const day = dayAtPointer(e.clientX);
    const rowId = dragUndated;
    setDragUndated(null);
    setDropDay(null);
    if (day !== null) void api.setCell(rowId, startProp.id, dayValue(day));
  };

  const addRow = async (lane: Group<Row> | null) => {
    const values: Record<string, unknown> = groupBy && lane ? groupDefaults(groupBy, lane) : {};
    // New rows start today, unless the lane is a date bucket of the start property itself.
    if (!isComputed(startProp.type) && !(startProp.id in values) && access.canEditValues(startProp.id)) {
      values[startProp.id] = dayValue(today);
    }
    await createNew(() => api.createRow({ properties: values }));
  };

  const toggleLane = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Where a row's bar is drawn (following a drag): its days and its left and right edges. */
  const barBox = (rowId: string) => {
    const span = spans.get(rowId)!;
    const shown = drag?.rowId === rowId && drag.moved ? dragSpan(span, drag.mode, drag.days) : span;
    // Bars reaching past the laid-out range are cut at its edge (a sliver when entirely outside).
    const left = Math.min(Math.max(dayX(shown.start, range, zoom), 0), width - 6);
    const right = Math.max(Math.min(dayX(shown.end + 1, range, zoom), width), 6);
    return { shown, left, right: Math.max(right, left + 6) };
  };

  const rowAt = (clientX: number, clientY: number) =>
    document.elementFromPoint(clientX, clientY)?.closest("[data-timeline-row]")?.getAttribute("data-timeline-row") ?? null;
  const trackPoint = (e: PointerEvent<HTMLElement>) => {
    const rect = body.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left - panelWidth, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };
  const onLinkPointerDown = (e: PointerEvent<HTMLElement>, row: Row) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setLink({ fromId: row.id, ...trackPoint(e), targetId: null });
  };
  const onLinkPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!link) return;
    const target = rowAt(e.clientX, e.clientY);
    const row = target && target !== link.fromId ? rows.find((r) => r.id === target) : undefined;
    setLink({ ...link, ...trackPoint(e), targetId: row && canLinkTo(row) ? row.id : null });
  };
  const onLinkPointerUp = () => {
    if (!link) return;
    const row = link.targetId ? rows.find((r) => r.id === link.targetId) : undefined;
    setLink(null);
    if (!row || !blockedBy) return;
    const current = storedBlockers(row, blockedBy.id);
    if (!current.includes(link.fromId)) void api.setCell(row.id, blockedBy.id, [...current, link.fromId]);
  };

  const barFor = (row: Row, color: string | null) => {
    const { shown, left, right } = barBox(row.id);
    const barWidth = right - left;
    const label = pageLabel(row.title, tc("untitled"));
    const dates =
      shown.start === shown.end
        ? format.dateTime(dayDate(shown.start), { dateStyle: "medium", timeZone: "UTC" })
        : format.dateTimeRange(dayDate(shown.start), dayDate(shown.end), { dateStyle: "medium", timeZone: "UTC" });
    const inside = barWidth >= MIN_LABEL_WIDTH;
    return (
      <div
        role="link"
        tabIndex={0}
        aria-label={t("timeline.barLabel", { title: label, dates })}
        title={`${label} · ${dates}`}
        onClick={() => {
          if (suppressClick.current) suppressClick.current = false;
          else open(row);
        }}
        onKeyDown={(e) => onBarKeyDown(e, row)}
        onPointerDown={(e) => onBarPointerDown(e, row, "move")}
        onPointerMove={onBarPointerMove}
        onPointerUp={() => onBarPointerUp(row)}
        onPointerCancel={() => setDrag(null)}
        style={{ left, width: barWidth, top: 5, height: ROW_HEIGHT - 10 }}
        className={cn(
          "group/bar absolute flex items-center rounded-md text-xs select-none",
          color ? `opt-${color}` : "board-card",
          canMove(row) ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          drag?.rowId === row.id && drag.moved && "z-10 shadow-md ring-2 ring-accent/50",
        )}
      >
        {inside && (
          <span className="flex min-w-0 items-center gap-1 px-2">
            {row.icon && <PageIcon icon={row.icon} className="shrink-0 text-xs" />}
            <span className={cn("truncate font-medium", !row.title && "opacity-60")}>{label}</span>
          </span>
        )}
        {!inside && (
          <span className="pointer-events-none absolute left-full ml-1.5 flex items-center gap-1 whitespace-nowrap text-fg-muted">
            {label}
          </span>
        )}
        {resizable && canMove(row) &&
          (["start", "end"] as const).map((edge) => (
            <span
              key={edge}
              aria-hidden
              title={t(edge === "start" ? "timeline.resizeStart" : "timeline.resizeEnd")}
              onPointerDown={(e) => onBarPointerDown(e, row, edge)}
              className={cn(
                "absolute inset-y-0 w-2 cursor-ew-resize rounded-md opacity-0 group-hover/bar:opacity-100 hover:bg-fg/15",
                edge === "start" ? "left-0" : "right-0",
              )}
            />
          ))}
        {canLinkFrom && (
          <span
            aria-hidden
            title={t("dependencies.link", { title: label })}
            onPointerDown={(e) => onLinkPointerDown(e, row)}
            onPointerMove={onLinkPointerMove}
            onPointerUp={onLinkPointerUp}
            onPointerCancel={() => setLink(null)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute top-1/2 -right-4 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-accent bg-bg",
              link?.fromId === row.id ? "opacity-100" : "opacity-0 group-hover/bar:opacity-100",
            )}
          />
        )}
      </div>
    );
  };

  // A sub-item starts where its parent does (or today), in the parent's lane when it can.
  const canAddSubItem =
    !readOnly && subItems.nested && !!subItems.parent && access.canEditValues(subItems.parent.id);
  const addSubItem = async (row: Row, lane: Group<Row> | null) => {
    if (!subItems.parent) return;
    subItems.expand(row.id);
    const values: Record<string, unknown> = groupBy && lane && canAddTo(lane) ? groupDefaults(groupBy, lane) : {};
    if (!isComputed(startProp.type) && !(startProp.id in values) && access.canEditValues(startProp.id)) {
      values[startProp.id] = startProp.type === "date" && row.properties[startProp.id] != null ? row.properties[startProp.id] : dayValue(today);
    }
    values[subItems.parent.id] = [row.id];
    await createNew(() => api.createRow({ properties: values }));
  };

  const tableRow = (line: SubItemLine<Row>, lane: Group<Row> | null) => {
    const row = line.row;
    const label = pageLabel(row.title, tc("untitled"));
    return (
    <div
      className="group/row sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-bg"
      style={{ width: panelWidth, height: ROW_HEIGHT }}
    >
      <div
        role="link"
        tabIndex={0}
        onClick={() => editTitleOf !== row.id && open(row)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && editTitleOf !== row.id && e.target === e.currentTarget) open(row);
        }}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 hover:bg-bg-hover"
        style={subItems.nested ? { paddingLeft: 4 + line.depth * SUB_ITEM_INDENT } : undefined}
      >
        {subItems.nested && <SubItemToggle line={line} title={label} onToggle={() => subItems.toggle(row.id)} className="-mr-1 h-6" />}
        <PageIcon icon={row.icon} className="shrink-0" />
        {editTitleOf === row.id ? (
          <CardTitleInput
            initial={typed || row.title}
            onDone={(title) => {
              stopEditing();
              if (title !== row.title) void api.setCell(row.id, TITLE, title);
            }}
          />
        ) : (
          <span className={cn("truncate text-sm", !row.title && "text-fg-faint")}>{label}</span>
        )}
        {subItems.parentsOnly && <SubItemCount count={line.children} />}
        {canAddSubItem && editTitleOf !== row.id && (
          <AddSubItemButton
            title={label}
            onAdd={() => void addSubItem(row, lane)}
            className="ml-auto shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          />
        )}
      </div>
      {tableProps.map((p) => (
        <div
          key={p.id}
          className="flex h-full shrink-0 items-center overflow-hidden border-l border-border px-2 text-xs text-fg-muted"
          style={{ width: PROP_WIDTH }}
          title={p.name}
        >
          {shownValues([p], row).length > 0 && <RowValue prop={p} row={row} />}
        </div>
      ))}
    </div>
    );
  };

  // A row added in a lane has to land in it (who created a row, and when, can't be chosen).
  const canAddTo = (lane: Group<Row> | null) =>
    !lane ||
    !groupBy ||
    ((lane.value.kind === "none" || access.canEditValues(groupBy.id)) && canAddToGroup(groupBy, lane, { viewerId, today: localDay(new Date()) }));

  const showsNewRow = (lane: Group<Row> | null) => !readOnly && showTable && canAddTo(lane);
  const newRowButton = (lane: Group<Row> | null) =>
    showsNewRow(lane) && (
      <div className="flex" style={{ height: ROW_HEIGHT - 4 }}>
        <button
          type="button"
          onClick={() => addRow(lane)}
          style={{ width: panelWidth }}
          className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border bg-bg px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("timeline.new")}
        </button>
      </div>
    );

  // The middle of each shown row's bar, down the body (a row in several lanes: its first one),
  // laid out as the lanes below are.
  const rowY = new Map<string, number>();
  let bodyHeight = HEADER_HEIGHT;
  for (const { key, group, lines } of lanes) {
    if (group) bodyHeight += ROW_HEIGHT;
    if (collapsed.has(key)) continue;
    for (const line of lines) {
      if (!rowY.has(line.row.id)) rowY.set(line.row.id, bodyHeight + ROW_HEIGHT / 2);
      bodyHeight += ROW_HEIGHT;
    }
    if (showsNewRow(group)) bodyHeight += ROW_HEIGHT - 4;
  }
  // An arrow from the end of the row waited for to the start of the waiting row; red when the
  // waiting row starts before the other one ends. Without room between them it goes around.
  const arrows = blockedBy
    ? dated.flatMap((row) => {
        const y2 = rowY.get(row.id);
        if (y2 === undefined) return [];
        return storedBlockers(row, blockedBy.id).flatMap((fromId) => {
          const y1 = rowY.get(fromId);
          if (y1 === undefined) return [];
          const from = barBox(fromId);
          const to = barBox(row.id);
          const x1 = from.right;
          const x2 = to.left;
          const between = y2 > y1 ? y2 - ROW_HEIGHT / 2 : y2 + ROW_HEIGHT / 2;
          const path =
            x2 - x1 >= ARROW_GAP * 2
              ? `M${x1} ${y1}H${x1 + ARROW_GAP}V${y2}H${x2}`
              : `M${x1} ${y1}H${x1 + ARROW_GAP}V${between}H${x2 - ARROW_GAP}V${y2}H${x2}`;
          return [{ key: `${fromId}>${row.id}`, path, late: to.shown.start <= from.shown.end }];
        });
      })
    : [];
  const linkFrom = link && rowY.has(link.fromId) ? { x: barBox(link.fromId).right, y: rowY.get(link.fromId)! } : null;

  const todayX = today >= range.start && today <= range.end ? dayX(today, range, zoom) + DAY_WIDTH[zoom] / 2 : null;
  const dropX = dragUndated && dropDay !== null ? dayX(dropDay, range, zoom) : null;

  return (
    <div className="page-gutter pb-6">
      <div className="flex flex-wrap items-center gap-1 pb-2">
        <button
          type="button"
          aria-pressed={showTable}
          title={t(showTable ? "timeline.hideTable" : "timeline.showTable")}
          aria-label={t(showTable ? "timeline.hideTable" : "timeline.showTable")}
          onClick={toggleTable}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {showTable ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </button>
        <span className="flex-1" />
        <div role="group" aria-label={t("timeline.zoom")} className="inline-flex rounded-md border border-border p-0.5">
          {TIMELINE_ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              aria-pressed={zoom === z}
              onClick={() => setZoom(z)}
              className={cn(
                "h-6 rounded px-2 text-xs",
                zoom === z ? "bg-bg-active font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
              )}
            >
              {t(`timeline.zooms.${z}`)}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => focusOn(today, 1 / 3)}>
          {t("calendar.today")}
        </Button>
      </div>

      <div
        ref={scroller}
        className="relative max-h-[calc(100dvh-14rem)] min-h-72 overflow-auto rounded-lg border border-border"
      >
        <div ref={body} className="relative" style={{ width: panelWidth + width }} onDragOver={onTimelineDragOver} onDrop={onTimelineDrop}>
          {/* Header: month (or year) labels over the columns, both sticky while scrolling down. */}
          <div className="sticky top-0 z-20 flex border-b border-border bg-bg" style={{ height: HEADER_HEIGHT }}>
            {showTable && (
              <div
                className="sticky left-0 z-10 flex shrink-0 items-end border-r border-border bg-bg text-xs text-fg-muted"
                style={{ width: panelWidth }}
              >
                <div className="flex min-w-0 flex-1 items-center px-2 pb-1.5">{t("nameColumn")}</div>
                {tableProps.map((p) => (
                  <div
                    key={p.id}
                    className="flex shrink-0 items-center gap-1 border-l border-border px-2 pb-1.5"
                    style={{ width: PROP_WIDTH }}
                  >
                    <span className="truncate">{p.name}</span>
                    <PropertyLock propertyId={p.id} />
                  </div>
                ))}
              </div>
            )}
            <div className="relative shrink-0" style={{ width }}>
              {header.top.map((u) => (
                <div
                  key={`t${u.start}`}
                  className="absolute top-0 flex h-6 items-center border-l border-border px-2 text-xs font-medium whitespace-nowrap first-letter:uppercase"
                  style={{ left: dayX(u.start, range, zoom), width: u.days * DAY_WIDTH[zoom] }}
                >
                  <span className="sticky truncate" style={{ left: panelWidth + 8 }}>
                    {zoom === "month"
                      ? dayDate(u.start).getUTCFullYear()
                      : format.dateTime(dayDate(u.start), { month: "long", year: "numeric", timeZone: "UTC" })}
                  </span>
                </div>
              ))}
              {header.columns.map((u) => (
                <div
                  key={`c${u.start}`}
                  className={cn(
                    "absolute top-6 flex h-6 items-center text-xs whitespace-nowrap tabular-nums",
                    zoom === "day" ? "justify-center" : "px-1.5",
                    u.start <= today && today < u.start + u.days ? "font-medium text-accent" : "text-fg-muted",
                  )}
                  style={{ left: dayX(u.start, range, zoom), width: u.days * DAY_WIDTH[zoom] }}
                >
                  {zoom === "day"
                    ? dayDate(u.start).getUTCDate()
                    : zoom === "week"
                      ? format.dateTime(dayDate(u.start), { day: "numeric", month: "short", timeZone: "UTC" })
                      : format.dateTime(dayDate(u.start), { month: "short", timeZone: "UTC" })}
                </div>
              ))}
            </div>
          </div>

          {/* Column lines, today and the drop target sit behind the bars. */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: panelWidth, width }}>
            {header.columns.map((u) => (
              <div
                key={u.start}
                className={cn(
                  "absolute inset-y-0 border-l border-border/60",
                  zoom === "day" && [0, 6].includes(dayDate(u.start).getUTCDay()) && "bg-bg-subtle",
                )}
                style={{ left: dayX(u.start, range, zoom), width: u.days * DAY_WIDTH[zoom] }}
              />
            ))}
            {todayX !== null && <div className="absolute inset-y-0 w-px bg-accent" style={{ left: todayX }} />}
            {dropX !== null && (
              <div className="absolute inset-y-0 bg-accent/15" style={{ left: dropX, width: DAY_WIDTH[zoom] }} />
            )}
          </div>

          {lanes.map(({ key, group, rows: laneRows, lines }) => {
            const expanded = !collapsed.has(key);
            const color = laneColor(group);
            return (
              <section key={key || "__none"} aria-label={group ? groupName(group) : undefined} className="relative">
                {group && (
                  <div className="flex border-b border-border" style={{ height: ROW_HEIGHT }}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleLane(key)}
                      className="sticky left-0 z-10 flex max-w-full min-w-0 items-center gap-1.5 bg-bg px-2 text-sm"
                    >
                      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform", expanded && "rotate-90")} />
                      {groupBy && <GroupLabel prop={groupBy} group={group} className="font-medium" />}
                      <span className="text-xs text-fg-muted tabular-nums">{laneRows.length}</span>
                    </button>
                  </div>
                )}
                {expanded &&
                  lines.map((line) => (
                    <div
                      key={line.row.id}
                      data-timeline-row={line.row.id}
                      className={cn("flex border-b border-border/60", link?.targetId === line.row.id && "bg-accent/10")}
                      style={{ height: ROW_HEIGHT }}
                    >
                      {showTable && tableRow(line, group)}
                      <div className="relative shrink-0" style={{ width }}>
                        {barFor(line.row, color)}
                      </div>
                    </div>
                  ))}
                {expanded && newRowButton(group)}
              </section>
            );
          })}
          {/* Dependency arrows over the bars, under the sticky table and header. */}
          {(arrows.length > 0 || linkFrom) && (
            <svg
              aria-hidden
              className="pointer-events-none absolute top-0 z-[5] overflow-visible"
              style={{ left: panelWidth }}
              width={width}
              height={bodyHeight}
            >
              <defs>
                {(["wait", "late"] as const).map((kind) => (
                  <marker
                    key={kind}
                    id={`${view.id}-arrow-${kind}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                    className={kind === "late" ? "text-danger" : "text-fg-muted"}
                  >
                    <path d="M0 0L8 4L0 8z" fill="currentColor" />
                  </marker>
                ))}
              </defs>
              {arrows.map((a) => (
                <path
                  key={a.key}
                  d={a.path}
                  fill="none"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  stroke="currentColor"
                  className={a.late ? "text-danger" : "text-fg-muted"}
                  markerEnd={`url(#${view.id}-arrow-${a.late ? "late" : "wait"})`}
                />
              ))}
              {link && linkFrom && (
                <path
                  d={`M${linkFrom.x} ${linkFrom.y}L${link.x} ${link.y}`}
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  className="text-accent"
                />
              )}
            </svg>
          )}
          {!dated.length && (
            <div className="sticky left-0 px-3 py-6 text-sm text-fg-muted" style={{ width: "min(100%, 28rem)" }}>
              {t("timeline.empty", { property: startProp.name })}
            </div>
          )}
          {!groupBy && !dated.length && newRowButton(null)}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={showUndated}
            onClick={() => setShowUndated((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showUndated && "rotate-90")} />
            {t("calendar.noDate", { count: undated.length, property: startProp.name })}
          </button>
          {showUndated && (
            <section aria-label={t("calendar.noDateTitle", { property: startProp.name })} className="mt-1">
              {movable && <p className="px-1.5 pb-1.5 text-xs text-fg-faint">{t("timeline.dragHint")}</p>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5">
                {undated.map((row) => (
                  <div
                    key={row.id}
                    role="link"
                    tabIndex={0}
                    draggable={canPlace(row)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", row.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragUndated(row.id);
                    }}
                    onDragEnd={() => {
                      setDragUndated(null);
                      setDropDay(null);
                    }}
                    onClick={() => open(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") open(row);
                    }}
                    className={cn(
                      "board-card flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs",
                      dragUndated === row.id && "opacity-40",
                    )}
                  >
                    <PageIcon icon={row.icon} className="shrink-0 text-xs" />
                    <span className={cn("truncate font-medium", !row.title && "text-fg-faint")}>
                      {pageLabel(row.title, tc("untitled"))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

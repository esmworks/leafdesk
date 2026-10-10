"use client";

import { ArrowDown, ArrowUp, Bot, ChevronRight, Ellipsis, EyeOff, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, MenuItem, MenuSeparator } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/use-media-query";
import { useReorderDrag, type ReorderDragHandlers } from "@/components/use-reorder-drag";
import type { ViewConfig } from "@/db/schema/app";
import type { AggregateFn } from "@/lib/aggregate";
import { valueType } from "@/lib/derived";
import { arrangeGroups, canAddToGroup, groupDefaults, groupRowsBy, type Group } from "@/lib/grouping";
import { isEmptyValue, lostValues, planConversion } from "@/lib/convert-property";
import { isGroupable, isSortable, moveProperty } from "@/lib/properties";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/lib/views";
import { pageLabel } from "@/lib/labels";
import type { SubItemLine } from "@/lib/sub-items";
import { AiCell, useAiAutofill } from "./ai-autofill";
import { BulkActionBar, SelectBox, useRowSelection } from "./bulk-actions";
import { uploadToPage } from "./files-cell";
import { Floating, useFloating } from "./floating";
import { GroupLabel, HiddenGroups, useGroupContext, useGroupName } from "./group-label";
import { usePeople } from "./person-cell";
import { OpenLink, PropertyCell } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import { PropertyAccessDialog } from "./property-access-dialog";
import { PropertyLock, usePropertyAccess } from "./property-access";
import { AddPropertyPanel, PropertyMenu, type PropertyMenuActions } from "./property-menu";
import { CalculationRow } from "./table-calculations";
import { useRelations } from "./relation-context";
import { QuickAddContext } from "./quick-add";
import { useNewRow } from "./use-new-row";
import { useToday } from "./use-today";
import { AddSubItemButton, SUB_ITEM_INDENT, SubItemCount, SubItemToggle, useSubItems } from "./sub-items";
import { TITLE, type Property, type Row, type View } from "./types";
import type { DatabaseApi } from "./use-database";

/** The Name column; narrower on phones so the next column peeks in. */
const NAME_WIDTH = { wide: 280, phone: 180 };
const WIDTHS: Partial<Record<Property["type"], number>> = { checkbox: 110, number: 140, date: 170 };
const defaultWidth = (p: Property) => WIDTHS[p.type] ?? 200;
/** Room frozen columns leave for the others to scroll by; below it they don't freeze. */
const MIN_SCROLL_ROOM = 160;

/** The implicit Name column as a text property; `name` is its translated label. */
export function titleProperty(databaseId: string, name: string): Property {
  return {
    id: TITLE,
    databaseId,
    name,
    type: "text",
    options: {},
    position: 0,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

export function TableView({
  workspaceId,
  databaseId,
  view,
  properties,
  rows,
  allRows = rows,
  api,
  readOnly,
  settingsReadOnly,
  locked,
  filtered,
  searched = false,
  guest,
  exportable,
  onFilter,
}: {
  workspaceId: string;
  databaseId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  /** Every row the viewer sees, the view's filters aside: what a type change would clear is counted on them. */
  allRows?: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  /** The view's settings can't be saved (a linked view its block doesn't let change), rows still can. */
  settingsReadOnly?: boolean;
  /** The schema is locked: rows stay editable, properties don't. */
  locked?: boolean;
  /** True when filters hide rows, to explain an empty table. */
  filtered: boolean;
  /** The search box narrowed the rows (see ViewSearch): an empty table says so. */
  searched?: boolean;
  /** Guests don't get bulk trash (see BulkActionBar). */
  guest?: boolean;
  /** Offers exporting the selection as CSV (see BulkActionBar). */
  exportable?: boolean;
  /** Adds a filter on a column (property id or "title") and opens the view's filters. */
  onFilter?: (columnId: string) => void;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const today = useToday();
  const { viewerId, people } = usePeople();
  const relations = useRelations();
  const ai = useAiAutofill();
  const access = usePropertyAccess();
  // Grouped only when the view asks for it (unlike boards, which always group).
  const groupBy = properties.find((p) => p.id === view.config.groupBy && isGroupable(p.type));
  const groupContext = useGroupContext(groupBy);
  const groupName = useGroupName(groupBy ?? { name: "" });
  // Viewers can't save the view, so their collapsing stays on this page.
  const [ownCollapsed, setOwnCollapsed] = useState<string[] | null>(null);
  const collapsed = useMemo(
    () => new Set(readOnly && ownCollapsed ? ownCollapsed : (view.config.collapsedGroups ?? [])),
    [readOnly, ownCollapsed, view.config.collapsedGroups],
  );
  const grouping = useMemo(
    () => (groupBy ? arrangeGroups(groupRowsBy(rows, groupBy, view.config, groupContext), view.config) : null),
    [rows, groupBy, view.config, groupContext],
  );
  // Sub-items nest under their parent within the table, or within each group.
  const subItems = useSubItems(view, properties, allRows);
  const linesOf = subItems.lines;
  const lines = useMemo(
    () => ({
      all: grouping ? [] : linesOf(rows),
      groups: new Map((grouping?.shown ?? []).map((g) => [g.key, linesOf(g.rows)] as const)),
    }),
    [grouping, rows, linesOf],
  );
  // Rows in the order they show, each once (a row with several tags shows in several groups):
  // what calculations count, and, leaving out collapsed groups and closed sub-items, what can be selected.
  // A view showing parents only leaves sub-items out of both; closed sub-items still count.
  const parentsOnly = subItems.parentsOnly;
  const [inView, expanded] = useMemo(() => {
    const unique = (rows: Row[]) => [...new Map(rows.map((r) => [r.id, r])).values()];
    if (!grouping) return [parentsOnly ? lines.all.map((l) => l.row) : rows, lines.all.map((l) => l.row)];
    return [
      unique(grouping.shown.flatMap((g) => (parentsOnly ? (lines.groups.get(g.key) ?? []).map((l) => l.row) : g.rows))),
      unique(grouping.shown.filter((g) => !collapsed.has(g.key)).flatMap((g) => (lines.groups.get(g.key) ?? []).map((l) => l.row))),
    ];
  }, [grouping, rows, collapsed, lines, parentsOnly]);
  const selection = useRowSelection(expanded);
  // Row controls before the Name column: the selection checkbox, plus the row menu for editors.
  const handles = readOnly ? 32 : 56;
  const phone = useMediaQuery(PHONE_QUERY);
  // The column being resized follows the pointer here; releasing saves the same width, so it doesn't jump.
  const [resizing, setResizing] = useState<{ key: string; width: number } | null>(null);
  const widthOf = (key: string, fallback: number) =>
    resizing?.key === key ? resizing.width : (view.config.columnWidths?.[key] ?? fallback);
  const colWidth = (p: Property) => widthOf(p.id, defaultWidth(p));
  // Phones keep the narrow Name column so the next one peeks in.
  const nameWidth = phone ? NAME_WIDTH.phone : widthOf(TITLE, NAME_WIDTH.wide);
  const hidden = new Set(view.config.hidden ?? []);
  const visible = properties.filter((p) => !hidden.has(p.id));
  const titleProp = titleProperty(databaseId, t("nameColumn"));
  const sortOf = (id: string) => view.config.sorts?.find((s) => s.propertyId === id)?.direction;

  // Frozen columns: the row controls and every column up to the one the view freezes through stay
  // put while the table scrolls sideways. A hidden freeze column freezes the shown ones before it.
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columnKeys = [TITLE, ...visible.map((p) => p.id)];
  const columnWidths = [nameWidth, ...visible.map(colWidth)];
  const allKeys = [TITLE, ...properties.map((p) => p.id)];
  const through = allKeys.indexOf(view.config.frozenThrough ?? "");
  const frozenIndex = through < 0 ? -1 : columnKeys.filter((key) => allKeys.indexOf(key) <= through).length - 1;
  const leftOf = (i: number) => handles + columnWidths.slice(0, i).reduce((sum, w) => sum + w, 0);
  // Phones, and windows too narrow to leave room to scroll past the frozen columns, ignore it.
  const frozenCount =
    frozenIndex >= 0 && !phone && (!boxWidth || leftOf(frozenIndex + 1) <= boxWidth - MIN_SCROLL_ROOM) ? frozenIndex + 1 : 0;
  /** Position and look of column `i` (-1: the row controls) when it is frozen. */
  const frozen = (i: number, selected = false) =>
    frozenCount > 0 && i < frozenCount
      ? {
          style: { left: i < 0 ? 0 : leftOf(i) },
          className: cn(
            "sticky z-30",
            selected ? "bg-[color-mix(in_srgb,var(--accent)_5%,var(--bg))]" : "bg-bg",
            i === frozenCount - 1 && "shadow-[inset_-1px_0_0_var(--border)]",
          ),
        }
      : { style: undefined, className: undefined };

  const setConfig = (config: ViewConfig) => api.updateView(view, { config });
  // Column widths and order change the view's settings, which only people who may save them change.
  const arrangeable = !readOnly && !settingsReadOnly;
  // The settings as they are when a resize ends, not as they were when it began.
  const latestConfig = useRef(view.config);
  useEffect(() => {
    latestConfig.current = view.config;
  }, [view.config]);
  function startResize(key: string, start: number, e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Captured, the handle keeps getting the pointer over other elements and outside the window.
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const from = e.clientX;
    let width = start;
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, start + ev.clientX - from)));
      setResizing({ key, width });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", end);
      const config = latestConfig.current;
      // Saving updates the view at once, in the same render that drops the live width.
      if (width !== start) void setConfig({ ...config, columnWidths: { ...config.columnWidths, [key]: width } });
      setResizing(null);
    };
    handle.addEventListener("pointermove", move);
    // Fires on release and cancel alike, once the capture ends.
    handle.addEventListener("lostpointercapture", end);
  }
  // `properties` is in the view's order with hidden ones too, so moving a column keeps them in place.
  const columnDrag = useReorderDrag("x", (moved, target, side) =>
    setConfig({ ...view.config, propertyOrder: moveProperty(properties, moved, target, side) }),
  );
  const setCalculation = (key: string, fn: AggregateFn | null) => {
    const calculations = { ...view.config.calculations };
    if (fn) calculations[key] = fn;
    else delete calculations[key];
    void setConfig({ ...view.config, calculations });
  };
  const wrapped = new Set(view.config.wrapped ?? []);
  const toggleWrap = (key: string) =>
    void setConfig({
      ...view.config,
      wrapped: wrapped.has(key) ? [...wrapped].filter((k) => k !== key) : [...wrapped, key],
    });
  // Changing a property's type: the values it would clear are counted here on the rows the viewer
  // sees, with the same conversion the server runs on every row.
  const typeChange = (p: Property): PropertyMenuActions["changeType"] => {
    const yes = t("propertyMenu.checkedText");
    return {
      lost: (type) => {
        const values = allRows.map((r) => r.properties[p.id]);
        if (values.every(isEmptyValue)) return 0;
        if (type === "relation") return null;
        const sourceTitles = new Map((relations?.targets[p.id]?.rows ?? []).map((r) => [r.id, r.title]));
        // Like the server, text only finds people still in the workspace.
        const known = type === "person" ? people.filter((person) => person.active) : people;
        return lostValues(values, planConversion(p, { type }, values, { people: known, sourceTitles, yes }));
      },
      apply: (change) => api.changePropertyType(p.id, { ...change, yes }),
    };
  };

  // A property added from a column's menu goes left or right of that column in this view.
  const placeBeside = (id: string | undefined, target: string, side: "before" | "after") => {
    if (!id || !arrangeable) return;
    const ids = properties.map((p) => p.id).filter((p) => p !== id);
    const propertyOrder = target === TITLE ? [id, ...ids] : moveProperty([...ids.map((p) => ({ id: p })), { id }], id, target, side);
    void setConfig({ ...latestConfig.current, propertyOrder });
  };
  const insertBeside = (target: string, sides: ("before" | "after")[]): PropertyMenuActions["insert"] => {
    if (locked || !arrangeable) return undefined;
    const place = (id: string | undefined, side: "before" | "after") => placeBeside(id, target, side);
    return {
      sides,
      onCreate: async (side, name, type, relation, derived) =>
        place((await api.addProperty(name, type, undefined, relation, derived))?.id, side),
      onCreateAutofill: ai.enabled
        ? async (side, name, config) => place((await api.addAutofillProperty(name, config, inView.map((r) => r.id)))?.id, side)
        : undefined,
    };
  };
  // What every column's menu does to the view; none of it when the view's settings can't be saved.
  const viewActions = (key: string, type: string): PropertyMenuActions =>
    settingsReadOnly
      ? {}
      : {
          filter: onFilter && (() => onFilter(key)),
          calculation: { type, fn: view.config.calculations?.[key], onChange: (fn) => setCalculation(key, fn) },
          toggleWrap: () => toggleWrap(key),
          wrapped: wrapped.has(key),
          // Up to a column that is frozen, the menu unfreezes instead (a freeze too wide to apply counts as none).
          ...(phone
            ? {}
            : frozenCount > columnKeys.indexOf(key)
              ? { unfreeze: () => setConfig({ ...view.config, frozenThrough: undefined }) }
              : { freeze: () => setConfig({ ...view.config, frozenThrough: key }) }),
        };
  const createOption = api.createOption;

  const addRow = async (group?: Group<Row>) => {
    const defaults = group && groupBy ? groupDefaults(groupBy, group) : {};
    await createNew(() => api.createRow(Object.keys(defaults).length ? { properties: defaults } : {}));
  };
  // A row given a parent (or sub-items) right in the table stays in sight: its new parent opens.
  const showMoved = (row: Row, propertyId: string, value: unknown) => {
    if (!subItems.nested || !Array.isArray(value)) return;
    if (propertyId === subItems.parent?.id && typeof value[0] === "string") subItems.expand(value[0]);
    if (propertyId === subItems.children?.id && value.length) subItems.expand(row.id);
  };
  // A sub-item lands in its parent's group too, so it shows right under it.
  const canAddSubItem = !readOnly && subItems.nested && !!subItems.parent && access.canEditValues(subItems.parent.id);
  const addSubItem = async (row: Row, group?: Group<Row>) => {
    if (!subItems.parent) return;
    subItems.expand(row.id);
    const defaults = group && groupBy && canAddTo(group) ? groupDefaults(groupBy, group) : {};
    await createNew(() => api.createRow({ properties: { ...defaults, [subItems.parent!.id]: [row.id] } }));
  };
  const canAddTo = (group: Group<Row>) =>
    !readOnly &&
    !!groupBy &&
    (group.value.kind === "none" || access.canEditValues(groupBy.id)) &&
    canAddToGroup(groupBy, group, { viewerId, today });

  const toggleCollapsed = (key: string) => {
    const next = collapsed.has(key) ? [...collapsed].filter((k) => k !== key) : [...collapsed, key];
    if (readOnly) setOwnCollapsed(next);
    else void setConfig({ ...view.config, collapsedGroups: next });
  };
  const setGroupHidden = (key: string, hide: boolean) => {
    const next = (view.config.hiddenGroups ?? []).filter((k) => k !== key);
    if (hide) next.push(key);
    void setConfig({ ...view.config, hiddenGroups: next });
  };

  const renderRow = (line: SubItemLine<Row>, group?: Group<Row>) => {
    const row = line.row;
    const selected = selection.isSelected(row.id);
    const label = pageLabel(row.title, tc("untitled"));
    return (
      <tr key={row.id} className={cn("group", selected && "bg-accent/5")}>
        <td className={cn("p-0 align-middle", frozen(-1, selected).className)} style={frozen(-1).style}>
          <div className="flex items-center justify-end">
            {!readOnly && <RowMenu workspaceId={workspaceId} rowId={row.id} onDelete={() => api.deleteRow(row.id)} />}
            <SelectBox
              checked={selection.isSelected(row.id)}
              label={t("bulk.selectRow")}
              visible={selection.some}
              onToggle={(range) => selection.toggle(row.id, range)}
            />
          </div>
        </td>
        <td
          className={cn("relative border-b border-border p-0 align-top", frozen(0, selected).className)}
          style={frozen(0).style}
        >
          <div className="flex font-medium" style={subItems.nested ? { paddingLeft: line.depth * SUB_ITEM_INDENT + 4 } : undefined}>
            {subItems.nested && <SubItemToggle line={line} title={label} onToggle={() => subItems.toggle(row.id)} className="h-[33px]" />}
            <div className="min-w-0 flex-1">
              <QuickAddContext value={editTitleOf === row.id ? quick : null}>
                <PropertyCell
                  prop={titleProp}
                  value={row.title}
                  wrap={wrapped.has(TITLE)}
                  readOnly={readOnly}
                  placeholder={tc("untitled")}
                  autoEdit={editTitleOf === row.id}
                  draft={editTitleOf === row.id ? typed : undefined}
                  onChange={(v) => {
                    stopEditing();
                    if (editTitleOf === row.id) quick.save(row.id, String(v ?? ""));
                    else void api.setCell(row.id, TITLE, v ?? "");
                  }}
                  onCreateOption={createOption}
                />
              </QuickAddContext>
            </div>
            {subItems.parentsOnly && line.children > 0 && (
              <span className="flex h-[33px] items-center pr-8">
                <SubItemCount count={line.children} />
              </span>
            )}
          </div>
          <span className="absolute inset-y-0 right-1 hidden items-center gap-1 group-hover:flex">
            {canAddSubItem && <AddSubItemButton title={label} onAdd={() => void addSubItem(row, group)} />}
            <OpenLink href={`/w/${workspaceId}/p/${row.id}`} />
          </span>
        </td>
        {visible.map((p, i) => {
          const valueAccess = access.valueAccess(row, p.id);
          return (
            <td
              key={p.id}
              className={cn("border-b border-l border-border p-0 align-top", frozen(i + 1, selected).className)}
              style={frozen(i + 1).style}
            >
              {valueAccess === "hidden" ? (
                <PropertyCell prop={p} value={undefined} hidden onChange={() => {}} onCreateOption={createOption} />
              ) : (
                <AiCell prop={p} rowId={row.id} readOnly={readOnly || valueAccess === "readOnly"}>
                  <PropertyCell
                    prop={p}
                    value={row.properties[p.id]}
                    wrap={wrapped.has(p.id)}
                    readOnly={readOnly || valueAccess === "readOnly"}
                    onChange={(v) => {
                      showMoved(row, p.id, v);
                      void api.setCell(row.id, p.id, v);
                    }}
                    onCreateOption={createOption}
                    upload={p.type === "files" ? uploadToPage(row.id) : undefined}
                  />
                </AiCell>
              )}
            </td>
          );
        })}
        {!readOnly && <td className="border-b border-l border-border" />}
      </tr>
    );
  };
  const columnCount = 2 + visible.length + (readOnly ? 0 : 1);
  const calculated = [TITLE, ...visible.map((p) => p.id)].some((key) => view.config.calculations?.[key]);
  const calculationColumns = [
    { key: TITLE, name: t("nameColumn"), type: TITLE, width: nameWidth },
    // A formula calculates like a property of its result type.
    ...visible.map((p) => ({ key: p.id, name: p.name, type: valueType(p), options: p.options, width: colWidth(p) })),
  ].map((column, i) => ({ ...column, frozen: frozen(i) }));

  const totalWidth = handles + nameWidth + visible.reduce((sum, p) => sum + colWidth(p), 0) + (readOnly ? 0 : 36);

  return (
    <div
      ref={box}
      className="page-gutter-table overflow-x-auto pb-3 [color-scheme:light_dark]"
      style={{ "--table-handles": `${handles + 8}px` } as React.CSSProperties}
    >
      <table className="table-fixed border-collapse text-sm" style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: handles }} />
          <col style={{ width: nameWidth }} />
          {visible.map((p) => (
            <col key={p.id} style={{ width: colWidth(p) }} />
          ))}
          {!readOnly && <col style={{ width: 36 }} />}
        </colgroup>
        <thead>
          <tr className="group">
            <th className={cn("p-0 font-normal", frozen(-1).className)} style={frozen(-1).style}>
              <div className="flex justify-end">
                <SelectBox
                  checked={selection.all}
                  indeterminate={selection.some && !selection.all}
                  label={t("bulk.selectAll")}
                  visible={selection.some}
                  onToggle={selection.toggleAll}
                />
              </div>
            </th>
            <HeaderCell
              prop={null}
              label={t("nameColumn")}
              icon="title"
              sort={sortOf(TITLE)}
              frozen={frozen(0)}
              readOnly={readOnly}
              onResize={!arrangeable || phone ? undefined : (e) => startResize(TITLE, nameWidth, e)}
              resizing={resizing?.key === TITLE}
              actions={{
                ...viewActions(TITLE, TITLE),
                sort: (direction) => setConfig({ ...view.config, sorts: [{ propertyId: TITLE, direction }] }),
                insert: insertBeside(TITLE, ["after"]),
              }}
            />
            {visible.map((p, i) => {
              // Property access: changing the property itself needs "edit" on it.
              const fixed = locked || !access.canEditSchema(p.id);
              return (
                <HeaderCell
                  key={p.id}
                  prop={p}
                  label={p.name}
                  icon={p.type}
                  sort={sortOf(p.id)}
                  frozen={frozen(i + 1)}
                  readOnly={readOnly}
                  drag={arrangeable ? columnDrag.handlers(p.id) : undefined}
                  onResize={arrangeable ? (e) => startResize(p.id, colWidth(p), e) : undefined}
                  resizing={resizing?.key === p.id}
                  actions={{
                    ...viewActions(p.id, valueType(p)),
                    group:
                      settingsReadOnly || !isGroupable(p.type) || groupBy?.id === p.id
                        ? undefined
                        : () => setConfig({ ...view.config, groupBy: p.id }),
                    ungroup: settingsReadOnly || groupBy?.id !== p.id ? undefined : () => setConfig({ ...view.config, groupBy: undefined }),
                    insert: insertBeside(p.id, ["before", "after"]),
                    rename: fixed ? undefined : (name) => api.renameProperty(p.id, name),
                    sort: isSortable(p.type)
                      ? (direction) => setConfig({ ...view.config, sorts: [{ propertyId: p.id, direction }] })
                      : undefined,
                    hide: settingsReadOnly ? undefined : () => setConfig({ ...view.config, hidden: [...(view.config.hidden ?? []), p.id] }),
                    setOptions: fixed ? undefined : (options) => api.setOptions(p, options),
                    setFormula: fixed ? undefined : (expression) => api.setFormula(p, expression),
                    setRollup: fixed ? undefined : (rollup) => api.setRollup(p, rollup),
                    setNumberFormat: fixed || p.type !== "number" ? undefined : (format) => api.setNumberFormat(p, format),
                    setDateOptions: fixed || p.type !== "date" ? undefined : (input) => api.setDateOptions(p, input),
                    setAutofill: fixed || !ai.enabled || p.type !== "text" ? undefined : (config) => api.setAutofill(p, config),
                    updateAllAutofill:
                      !ai.enabled || !ai.refresh || !p.options.ai || !access.canEditValues(p.id)
                        ? undefined
                        : () => ai.refresh?.(p.id, inView.map((r) => r.id)),
                    duplicate: fixed
                      ? undefined
                      : async () =>
                          placeBeside(
                            (await api.duplicateProperty(p.id, t("propertyMenu.copyName", { name: p.name })))?.id,
                            p.id,
                            "after",
                          ),
                    changeType: fixed ? undefined : typeChange(p),
                    remove: fixed ? undefined : () => api.deleteProperty(p.id),
                  }}
                />
              );
            })}
            {!readOnly && (
              <th className="border-y border-border p-0 text-left font-normal">
                {!locked && (
                  <AddPropertyButton
                    onCreate={(name, type, relation, derived) => api.addProperty(name, type, undefined, relation, derived)}
                    onCreateAutofill={
                      ai.enabled ? (name, config) => api.addAutofillProperty(name, config, inView.map((r) => r.id)) : undefined
                    }
                  />
                )}
              </th>
            )}
          </tr>
        </thead>
        {!grouping ? (
          <tbody>{lines.all.map((line) => renderRow(line))}</tbody>
        ) : (
          grouping.shown.map((group) => {
            const open = !collapsed.has(group.key);
            const name = groupName(group);
            return (
              <tbody key={group.key || "__none"} aria-label={name}>
                <tr>
                  <td colSpan={columnCount} className="p-0">
                    <GroupHeader
                      prop={groupBy!}
                      group={group}
                      name={name}
                      open={open}
                      offset={handles}
                      readOnly={readOnly}
                      canAdd={canAddTo(group)}
                      onToggle={() => toggleCollapsed(group.key)}
                      onHide={() => setGroupHidden(group.key, true)}
                      onAdd={() => addRow(group)}
                    />
                  </td>
                </tr>
                {open && (lines.groups.get(group.key) ?? []).map((line) => renderRow(line, group))}
                {open && canAddTo(group) && (
                  <tr>
                    <td colSpan={columnCount} className="p-0">
                      <button
                        type="button"
                        onClick={() => addRow(group)}
                        className="flex h-[33px] w-full items-center gap-1.5 px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                        style={{ paddingLeft: handles + 8 }}
                      >
                        <Plus className="h-4 w-4" />
                        {t("table.new")}
                      </button>
                    </td>
                  </tr>
                )}
                {open && calculated && group.rows.length > 0 && (
                  <tr>
                    <td colSpan={columnCount} className="p-0">
                      {/* Per-group results; calculations are picked in the table's own footer. */}
                      <CalculationRow
                        offset={handles}
                        columns={calculationColumns}
                        rows={parentsOnly ? (lines.groups.get(group.key) ?? []).map((l) => l.row) : group.rows}
                        calculations={view.config.calculations}
                        readOnly
                        onChange={setCalculation}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })
        )}
      </table>
      {(grouping ? !grouping.shown.length : !rows.length) && (
        <div
          className="border-b border-border px-2 py-6 text-sm text-fg-faint"
          style={{ marginLeft: handles, width: totalWidth - handles }}
        >
          {searched ? t("table.noSearchMatches") : filtered ? t("table.noMatches") : t("table.noRows")}
        </div>
      )}
      {grouping && grouping.hidden.length > 0 && (
        <div style={{ marginLeft: handles }}>
          <HiddenGroups
            prop={groupBy!}
            groups={grouping.hidden}
            readOnly={readOnly}
            onShow={(key) => setGroupHidden(key, false)}
          />
        </div>
      )}
      {!readOnly && !grouping && (
        <button
          type="button"
          onClick={() => addRow()}
          className="flex h-[33px] items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          style={{ marginLeft: handles, width: totalWidth - handles }}
        >
          <Plus className="h-4 w-4" />
          {t("table.new")}
        </button>
      )}
      <CalculationRow
        offset={handles}
        columns={calculationColumns}
        rows={inView}
        calculations={view.config.calculations}
        readOnly={readOnly}
        onChange={setCalculation}
      />
      <BulkActionBar
        workspaceId={workspaceId}
        databaseId={databaseId}
        properties={properties}
        rows={expanded}
        selection={selection}
        api={api}
        readOnly={readOnly}
        guest={guest}
        exportable={exportable}
      />
    </div>
  );
}

/**
 * A group's title row in a grouped table: collapse toggle, name and row count, then (on hover)
 * hiding the group and adding a row to it. Stays at the left edge while the table scrolls sideways.
 */
function GroupHeader({
  prop,
  group,
  name,
  open,
  offset,
  readOnly,
  canAdd,
  onToggle,
  onHide,
  onAdd,
}: {
  prop: Property;
  group: Group<Row>;
  name: string;
  open: boolean;
  offset: number;
  readOnly?: boolean;
  canAdd: boolean;
  onToggle: () => void;
  onHide: () => void;
  onAdd: () => void;
}) {
  const t = useTranslations("database");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <div
      className="group/grp sticky left-0 flex h-10 w-max items-center gap-1.5 pt-2"
      style={{ paddingLeft: Math.max(offset - 28, 0) }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(open ? "group.collapse" : "group.expand", { name })}
        title={t(open ? "group.collapse" : "group.expand", { name })}
        onClick={onToggle}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
      </button>
      <GroupLabel prop={prop} group={group} className="font-medium" />
      <span className="text-xs text-fg-muted tabular-nums" title={t("group.rowCount", { count: group.rows.length })}>
        {group.rows.length}
      </span>
      {!readOnly && (
        <>
          <button
            ref={menu.ref}
            type="button"
            aria-label={t("group.actions")}
            title={t("group.actions")}
            onClick={menu.toggle}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100",
              menu.open ? "opacity-100" : "opacity-0 group-hover/grp:opacity-100",
            )}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
          <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
            <MenuItem
              icon={<EyeOff className="h-3.5 w-3.5" />}
              onClick={() => {
                menu.close();
                onHide();
              }}
            >
              {t("board.hideGroup")}
            </MenuItem>
          </Floating>
        </>
      )}
      {canAdd && (
        <button
          type="button"
          aria-label={t("group.addRow", { name })}
          title={t("group.addRow", { name })}
          onClick={onAdd}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted opacity-0 group-hover/grp:opacity-100 hover:bg-bg-hover hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function HeaderCell({
  prop,
  label,
  icon,
  sort,
  frozen,
  readOnly,
  drag,
  onResize,
  resizing,
  actions,
}: {
  prop: Property | null;
  label: string;
  icon: Property["type"] | "title";
  sort?: "asc" | "desc";
  /** A frozen column's position and look (see TableView). */
  frozen?: { style?: React.CSSProperties; className?: string };
  readOnly?: boolean;
  /** Moving the column by dragging its header; only property columns move. */
  drag?: ReorderDragHandlers;
  /** Starts resizing the column from the handle on its right edge. */
  onResize?: (e: React.PointerEvent<HTMLElement>) => void;
  /** The column is being resized: its handle stays lit. */
  resizing?: boolean;
  actions: React.ComponentProps<typeof PropertyMenu>["actions"];
}) {
  const t = useTranslations("database.table");
  const tAi = useTranslations("ai.autofill");
  const menu = useFloating<HTMLButtonElement>();
  const access = usePropertyAccess();
  const [accessOpen, setAccessOpen] = useState(false);
  const menuActions = prop && access.canManage ? { ...actions, openAccess: () => setAccessOpen(true) } : actions;
  return (
    <th
      data-column={prop?.id}
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      style={frozen?.style}
      className={cn(
        "relative border-y border-border p-0 text-left font-normal",
        prop && "border-l",
        drag?.dragging && "opacity-50",
        frozen?.className,
      )}
    >
      {drag?.dropSide && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-accent", drag.dropSide === "before" ? "-left-px" : "-right-px")}
        />
      )}
      <button
        ref={menu.ref}
        type="button"
        disabled={readOnly}
        onClick={menu.toggle}
        className="flex h-[33px] w-full items-center gap-1.5 px-2 text-sm text-fg-muted hover:bg-bg-hover disabled:hover:bg-transparent"
      >
        <PropertyTypeIcon type={icon} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {prop && <PropertyLock propertyId={prop.id} />}
        {prop?.type === "text" && prop.options.ai && <Bot className="h-3.5 w-3.5 shrink-0" aria-label={tAi("addEntry")} />}
        {sort === "asc" && <ArrowUp className="h-3 w-3 shrink-0 text-accent" aria-label={t("sortedAscending")} />}
        {sort === "desc" && <ArrowDown className="h-3 w-3 shrink-0 text-accent" aria-label={t("sortedDescending")} />}
      </button>
      {onResize && (
        <span
          aria-hidden
          // Draggable and cancelled, so pressing here doesn't start dragging the column itself.
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={onResize}
          onClick={(e) => e.stopPropagation()}
          className="group/resize absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-[3px] w-0.5 transition-colors group-hover/resize:bg-accent/60",
              resizing && "bg-accent",
            )}
          />
        </span>
      )}
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} className="max-h-[calc(100vh-1rem)] overflow-y-auto">
        <PropertyMenu prop={prop} actions={menuActions} onDone={menu.close} />
      </Floating>
      {prop && accessOpen && <PropertyAccessDialog prop={prop} onClose={() => setAccessOpen(false)} />}
    </th>
  );
}

function AddPropertyButton({
  onCreate,
  onCreateAutofill,
}: {
  onCreate: React.ComponentProps<typeof AddPropertyPanel>["onCreate"];
  onCreateAutofill?: React.ComponentProps<typeof AddPropertyPanel>["onCreateAutofill"];
}) {
  const t = useTranslations("database.table");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        aria-label={t("addProperty")}
        title={t("addProperty")}
        onClick={menu.toggle}
        className="flex h-[33px] w-full items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <Plus className="h-4 w-4" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <AddPropertyPanel onCreate={onCreate} onCreateAutofill={onCreateAutofill} onDone={menu.close} />
      </Floating>
    </>
  );
}

function RowMenu({ workspaceId, rowId, onDelete }: { workspaceId: string; rowId: string; onDelete: () => void }) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const menu = useFloating<HTMLButtonElement>();
  const router = useRouter();
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        aria-label={t("table.rowActions")}
        onClick={menu.toggle}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded text-fg-faint hover:bg-bg-hover hover:text-fg",
          menu.open ? "visible" : "invisible group-hover:visible pointer-coarse:visible",
        )}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
        <MenuItem
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          onClick={() => {
            menu.close();
            router.push(`/w/${workspaceId}/p/${rowId}`);
          }}
        >
          {t("rowMenu.open")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => {
            menu.close();
            onDelete();
          }}
        >
          {tc("delete")}
        </MenuItem>
      </Floating>
    </>
  );
}

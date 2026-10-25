"use client";

import { cellMarkClass, colorMarkClass, type RowColors } from "@/lib/color-rules";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { isGroupable, isHiddenInView } from "@/lib/properties";
import type { SubItemLine } from "@/lib/sub-items";
import { CardTitleInput } from "./card-title-input";
import { RowMenu } from "./gallery-view";
import { uploadToPage } from "./files-cell";
import { PropertyCell, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { openRowProps, useIsOpenRow, useRowOpener } from "./row-panel-context";
import { useNewRow } from "./use-new-row";
import { useTableWindow } from "./use-table-window";
import { usePropertyAccess } from "./property-access";
import { AddSubItemButton, SUB_ITEM_INDENT, SubItemCount, SubItemToggle, useSubItems } from "./sub-items";
import type { Property, Row, View } from "./types";
import { ViewSections, type SectionGroup } from "./view-sections";
import type { DatabaseApi } from "./use-database";

/** A line's height before it is measured (see useTableWindow). */
const LINE_HEIGHT = 37;

/**
 * One compact line per row: title on the left, the properties the view shows on the right. Values
 * edit in place with the table's editors; Tab and Shift+Tab move between a line's values, and
 * Shift+Enter on a line adds a row right below it.
 */
export function ListView({
  workspaceId,
  view,
  properties,
  rows,
  allRows = rows,
  api,
  readOnly,
  colors,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  /** Every row the viewer sees, the view's filters aside: whether a row has a parent is read there. */
  allRows?: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  /** What the view's color rules color, by row id (see lib/color-rules). */
  colors?: ReadonlyMap<string, RowColors>;
}) {
  const t = useTranslations("database");
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const shownProps = properties.filter((p) => !isHiddenInView(view, p));
  const access = usePropertyAccess();
  const subItems = useSubItems(view, properties, allRows);
  const canAddSubItem = !readOnly && subItems.nested && !!subItems.parent && access.canEditValues(subItems.parent.id);
  const [start, setStart] = useState<HTMLDivElement | null>(null);

  const add = async (values?: Record<string, unknown>) => {
    await createNew(() => api.createRow(values && Object.keys(values).length ? { properties: values } : {}));
  };
  const addSubItem = async (row: Row) => {
    if (!subItems.parent) return;
    subItems.expand(row.id);
    await createNew(() => api.createRow({ properties: { [subItems.parent!.id]: [row.id] } }));
  };
  /**
   * A new row right below `row` (Shift+Enter), with the view's filter values like any new row, and
   * under the same parent while sub-items nest, in the same section with its value. A sorted view
   * puts it where its values go.
   */
  const addBelow = async (row: Row, groupValues?: Record<string, unknown>) => {
    const parent = subItems.nested && subItems.parent && access.canEditValues(subItems.parent.id) ? subItems.parent : null;
    const parentValue = parent ? row.properties[parent.id] : undefined;
    const values = { ...groupValues, ...(parent && Array.isArray(parentValue) && parentValue.length ? { [parent.id]: parentValue } : {}) };
    const properties = Object.keys(values).length ? values : undefined;
    await createNew(async () => {
      const id = await api.createRow(properties ? { properties } : {});
      if (id && !view.config.sorts?.length) void api.moveRowBeside(id, row.id, "after");
      return id;
    });
  };

  // Long lists draw only the lines near what's visible, as tables do (see useTableWindow). A list
  // in sections draws the lines of its open sections; folding one away is what makes it shorter.
  const grouped = properties.some((p) => p.id === view.config.groupBy && isGroupable(p.type));
  const lines = subItems.lines(rows);
  const body = useTableWindow({ start, count: grouped ? 0 : lines.length, estimate: () => LINE_HEIGHT, keyOf: (i) => lines[i].row.id });
  // A new line whose title is being typed is scrolled to once, should it be outside what's drawn.
  const editIndex = editTitleOf && !grouped ? lines.findIndex((line) => line.row.id === editTitleOf) : -1;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!editTitleOf || editIndex < 0 || revealed.current === editTitleOf) return;
    revealed.current = editTitleOf;
    body.reveal(editIndex);
  }, [editTitleOf, editIndex, body]);

  const listRow = (line: SubItemLine<Row>, index: number, group: SectionGroup | null) => (
    <ListRow
      key={line.row.id}
      index={index}
      measure={group ? undefined : body.measure}
      workspaceId={workspaceId}
      line={line}
      showIcon={view.config.showIcons !== false}
      nested={subItems.nested}
      onToggle={() => subItems.toggle(line.row.id)}
      onAddSubItem={canAddSubItem ? () => void addSubItem(line.row) : undefined}
      props={shownProps}
      color={colors?.get(line.row.id)}
      readOnly={readOnly}
      editTitle={editTitleOf === line.row.id}
      typed={typed}
      onTitle={(title) => {
        stopEditing();
        if (title !== line.row.title) quick.save(line.row.id, title);
      }}
      onDelete={() => api.deleteRow(line.row.id)}
      api={api}
      onAddBelow={readOnly ? undefined : () => void addBelow(line.row, group?.values)}
    />
  );

  return (
    <QuickAddContext value={quick}>
      <div className="page-gutter pb-6">
        <div ref={setStart} aria-hidden />
        <ViewSections view={view} properties={properties} rows={rows} api={api} readOnly={readOnly} onAdd={(values) => void add(values)}>
          {(sectionRows, group) => {
            const addHere = group ? group.add : readOnly ? undefined : () => void add();
            return (
              <>
                <div role="list" className="flex flex-col">
                  {group ? (
                    subItems.lines(sectionRows).map((line, i) => listRow(line, i, group))
                  ) : (
                    <>
                      {body.padTop > 0 && <div aria-hidden style={{ height: body.padTop }} />}
                      {body.indexes.map((index) => listRow(lines[index], index, null))}
                      {body.padBottom > 0 && <div aria-hidden style={{ height: body.padBottom }} />}
                    </>
                  )}
                </div>
                {!group && !rows.length && readOnly && <p className="py-10 text-center text-sm text-fg-muted">{t("list.empty")}</p>}
                {/* In sections each group adds its own rows, with its value. */}
                {addHere && (
                  <button
                    type="button"
                    onClick={addHere}
                    className="mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("list.new")}
                  </button>
                )}
              </>
            );
          }}
        </ViewSections>
      </div>
    </QuickAddContext>
  );
}

function ListRow({
  workspaceId,
  index,
  measure,
  line,
  showIcon,
  nested,
  onToggle,
  onAddSubItem,
  props,
  color,
  readOnly,
  editTitle,
  typed,
  onTitle,
  onDelete,
  api,
  onAddBelow,
}: {
  workspaceId: string;
  /** The line's place in the list, and what measures its height (see useTableWindow). */
  index: number;
  measure?: (el: HTMLElement | null) => void;
  line: SubItemLine<Row>;
  /** The view shows rows' page icons (see ViewConfig showIcons). */
  showIcon: boolean;
  /** Sub-items show under their parent: rows get an open/close arrow and are indented. */
  nested: boolean;
  onToggle: () => void;
  onAddSubItem?: () => void;
  props: Property[];
  /** What color rules color on the line: the whole line, its name or values. */
  color?: RowColors;
  readOnly?: boolean;
  editTitle: boolean;
  /** Typed before the title editor opened. */
  typed?: string;
  onTitle: (title: string) => void;
  onDelete: () => void;
  api: DatabaseApi;
  /** Adds a row below this one (Shift+Enter); missing where rows can't be added. */
  onAddBelow?: () => void;
}) {
  const tc = useTranslations("common");
  const opener = useRowOpener(workspaceId);
  const access = usePropertyAccess();
  const box = useRef<HTMLDivElement>(null);
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      measure?.(el);
    },
    [measure],
  );
  const row = line.row;
  const isOpen = useIsOpenRow(opener, row.id);
  const shown = shownValues(props, row);
  const label = pageLabel(row.title, tc("untitled"));

  /** Moves the focus from the title or a value to the next value (`back`: the one before); false at either end. */
  const moveFocus = (from: Element, back: boolean) => {
    const stops = [...(box.current?.querySelectorAll<HTMLElement>("[data-list-title], [data-list-values] [data-cell-edit]") ?? [])];
    const at = stops.indexOf(from as HTMLElement);
    const next = at < 0 ? undefined : stops[at + (back ? -1 : 1)];
    next?.focus();
    return !!next;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in an editor (shown over the line, outside it) are the editor's.
    if (!box.current?.contains(e.target as Node) || e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && e.shiftKey && onAddBelow && !editTitle) {
      e.preventDefault();
      onAddBelow();
    } else if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && moveFocus(e.target as Element, e.shiftKey)) {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={setBox}
      data-index={index}
      role="listitem"
      onKeyDown={onKeyDown}
      className={cn(
        "group relative flex min-h-9 items-center gap-2 border-b border-border px-2 hover:bg-bg-hover",
        isOpen && "bg-bg-hover",
        color?.row && `${colorMarkClass(color.row)} mark-hover`,
      )}
      style={nested ? { paddingInlineStart: 4 + line.depth * SUB_ITEM_INDENT } : undefined}
    >
      {nested && <SubItemToggle line={line} title={label} onToggle={onToggle} className="-me-1 h-6" />}
      <div
        role="link"
        tabIndex={0}
        data-list-title=""
        {...openRowProps(opener, row.id, !editTitle)}
        onClick={(e) => !editTitle && opener.open(row.id, e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !editTitle && e.target === e.currentTarget) opener.open(row.id, e);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-sm"
      >
        {showIcon && <PageIcon icon={row.icon} className="shrink-0" />}
        {editTitle ? (
          <CardTitleInput initial={typed || row.title} onDone={onTitle} />
        ) : (
          <span className={cn("min-w-0 truncate text-sm font-medium", !row.title && "text-fg-faint", cellMarkClass(color, "title"))}>{label}</span>
        )}
        {!nested && <SubItemCount count={line.children} />}
      </div>
      {shown.length > 0 && (
        // Values are chips: they shrink from the left on narrow screens so the title keeps its room.
        <div data-list-values="" className="flex max-w-[60%] min-w-0 shrink items-center justify-end gap-1 overflow-hidden text-xs text-fg-muted">
          {shown.map((p) => {
            const valueAccess = access.valueAccess(row, p.id);
            return (
              <span key={p.id} className={cn("flex min-w-0 shrink-0 items-center last:shrink", cellMarkClass(color, p.id))} title={p.name}>
                <PropertyCell
                  variant="list"
                  prop={p}
                  value={row.properties[p.id]}
                  style={row.styles?.[p.id]}
                  hidden={valueAccess === "hidden"}
                  readOnly={readOnly || valueAccess === "readOnly"}
                  onChange={(v) => void api.setCell(row.id, p.id, v)}
                  onCreateOption={api.createOption}
                  rowValues={row.properties}
                  upload={p.type === "files" ? uploadToPage(row.id) : undefined}
                  onTab={(cell, back) => moveFocus(cell, back)}
                />
              </span>
            );
          })}
        </div>
      )}
      {onAddSubItem && !editTitle && (
        <AddSubItemButton title={label} onAdd={onAddSubItem} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
      )}
      {!readOnly && !editTitle && <RowMenu opener={opener} rowId={row.id} onDelete={onDelete} className="shrink-0" />}
    </div>
  );
}

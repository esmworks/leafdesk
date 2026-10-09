"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView } from "@/lib/properties";
import type { SubItemLine } from "@/lib/sub-items";
import { CardTitleInput } from "./board-view";
import { RowMenu } from "./gallery-view";
import { RowValue, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { useNewRow } from "./use-new-row";
import { usePropertyAccess } from "./property-access";
import { AddSubItemButton, SUB_ITEM_INDENT, SubItemCount, SubItemToggle, useSubItems } from "./sub-items";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";

/** One compact line per row: title on the left, the properties the view shows on the right. */
export function ListView({
  workspaceId,
  view,
  properties,
  rows,
  allRows = rows,
  api,
  readOnly,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  /** Every row the viewer sees, the view's filters aside: whether a row has a parent is read there. */
  allRows?: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
}) {
  const t = useTranslations("database");
  const { editTitleOf, typed, create: createNew, stopEditing, saveTitle, quick } = useNewRow(api, view, properties);
  const shownProps = properties.filter((p) => !isHiddenInView(view, p));
  const access = usePropertyAccess();
  const subItems = useSubItems(view, properties, allRows);
  const canAddSubItem = !readOnly && subItems.nested && !!subItems.parent && access.canEditValues(subItems.parent.id);

  const add = async () => {
    await createNew(() => api.createRow());
  };
  const addSubItem = async (row: Row) => {
    if (!subItems.parent) return;
    subItems.expand(row.id);
    await createNew(() => api.createRow({ properties: { [subItems.parent!.id]: [row.id] } }));
  };

  return (
    <QuickAddContext value={quick}>
      <div className="page-gutter pb-6">
        <div role="list" className="flex flex-col">
          {subItems.lines(rows).map((line) => (
            <ListRow
              key={line.row.id}
              workspaceId={workspaceId}
              line={line}
              nested={subItems.nested}
              onToggle={() => subItems.toggle(line.row.id)}
              onAddSubItem={canAddSubItem ? () => void addSubItem(line.row) : undefined}
              props={shownProps}
              readOnly={readOnly}
              editTitle={editTitleOf === line.row.id}
              typed={typed}
              onTitle={(title) => {
                stopEditing();
                if (title !== line.row.title) saveTitle(line.row.id, title);
              }}
              onDelete={() => api.deleteRow(line.row.id)}
            />
          ))}
        </div>
        {!rows.length && readOnly && <p className="py-10 text-center text-sm text-fg-muted">{t("list.empty")}</p>}
        {!readOnly && (
          <button
            type="button"
            onClick={add}
            className="mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("list.new")}
          </button>
        )}
      </div>
    </QuickAddContext>
  );
}

function ListRow({
  workspaceId,
  line,
  nested,
  onToggle,
  onAddSubItem,
  props,
  readOnly,
  editTitle,
  typed,
  onTitle,
  onDelete,
}: {
  workspaceId: string;
  line: SubItemLine<Row>;
  /** Sub-items show under their parent: rows get an open/close arrow and are indented. */
  nested: boolean;
  onToggle: () => void;
  onAddSubItem?: () => void;
  props: Property[];
  readOnly?: boolean;
  editTitle: boolean;
  /** Typed before the title editor opened. */
  typed?: string;
  onTitle: (title: string) => void;
  onDelete: () => void;
}) {
  const tc = useTranslations("common");
  const router = useRouter();
  const row = line.row;
  const href = `/w/${workspaceId}/p/${row.id}`;
  const shown = shownValues(props, row);
  const label = pageLabel(row.title, tc("untitled"));
  return (
    <div
      role="listitem"
      className="group relative flex min-h-9 items-center gap-2 border-b border-border px-2 hover:bg-bg-hover"
      style={nested ? { paddingLeft: 4 + line.depth * SUB_ITEM_INDENT } : undefined}
    >
      {nested && <SubItemToggle line={line} title={label} onToggle={onToggle} className="-mr-1 h-6" />}
      <div
        role="link"
        tabIndex={0}
        onClick={() => !editTitle && router.push(href)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !editTitle && e.target === e.currentTarget) router.push(href);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-sm"
      >
        <PageIcon icon={row.icon} className="shrink-0" />
        {editTitle ? (
          <CardTitleInput initial={typed || row.title} onDone={onTitle} />
        ) : (
          <span className={cn("min-w-0 truncate text-sm font-medium", !row.title && "text-fg-faint")}>{label}</span>
        )}
        {!nested && <SubItemCount count={line.children} />}
        {shown.length > 0 && (
          // Values are chips: they shrink from the left on narrow screens so the title keeps its room.
          <div className="ml-auto flex max-w-[60%] min-w-0 shrink items-center justify-end gap-3 overflow-hidden text-xs text-fg-muted">
            {shown.map((p) => (
              <span key={p.id} className="flex min-w-0 shrink-0 items-center last:shrink" title={p.name}>
                <RowValue prop={p} row={row} />
              </span>
            ))}
          </div>
        )}
      </div>
      {onAddSubItem && !editTitle && (
        <AddSubItemButton title={label} onAdd={onAddSubItem} className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
      )}
      {!readOnly && !editTitle && <RowMenu href={href} onDelete={onDelete} className="shrink-0" />}
    </div>
  );
}

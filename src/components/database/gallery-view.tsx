"use client";

import { cellMarkClass, colorMarkClass, type RowColors } from "@/lib/color-rules";
import { Ellipsis, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useMemo, useState } from "react";
import { cn, MenuItem, MenuSeparator, PageIcon } from "@/components/ui";
import type { CardSize } from "@/db/schema/app";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView } from "@/lib/properties";
import { firstImageFile } from "@/lib/files";
import { coverProperty, galleryCover } from "@/lib/views";
import { CardTitleInput } from "./card-title-input";
import { Floating, useFloating } from "./floating";
import { OpenRowItems } from "./open-row-items";
import { RowValue, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { openRowProps, useIsOpenRow, useRowOpener, type RowOpener } from "./row-panel-context";
import { useNewRow } from "./use-new-row";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";

/** Narrowest card per size; the grid fits as many as the width allows. */
const CARD_WIDTH: Record<CardSize, string> = { small: "11rem", medium: "15rem", large: "20rem" };
const COVER_HEIGHT: Record<CardSize, string> = { small: "h-24", medium: "h-36", large: "h-48" };

export function GalleryView({
  workspaceId,
  view,
  properties,
  rows,
  api,
  readOnly,
  colors,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  /** What the view's color rules color, by row id (see lib/color-rules). */
  colors?: ReadonlyMap<string, RowColors>;
}) {
  const t = useTranslations("database");
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const size = view.config.cardSize ?? "medium";
  const showIcons = view.config.showIcons !== false;
  const wrapProperties = view.config.wrapProperties === true;
  // Covers come from each row's body (first_image) or from a files property's first image.
  const source = galleryCover(view.config);
  const coverProp = coverProperty(view.config, properties);
  const withCover = source === "first_image" || coverProp !== null;
  const coverOf = (row: Row) => (coverProp ? (firstImageFile(row.properties[coverProp.id])?.url ?? null) : (row.cover ?? null));
  // The cards get props that stay the same while another card's title is edited.
  const cardProps = useMemo(() => properties.filter((p) => !isHiddenInView(view, p)), [properties, view]);
  const onCardTitle = useCallback(
    (row: Row, title: string) => {
      stopEditing();
      if (title !== row.title) quick.save(row.id, title);
    },
    [stopEditing, quick],
  );
  const onCardDelete = useCallback((rowId: string) => void api.deleteRow(rowId), [api]);

  const add = async () => {
    await createNew(() => api.createRow());
  };

  return (
    <QuickAddContext value={quick}>
      <div className="page-gutter pb-6">
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${CARD_WIDTH[size]}, 100%), 1fr))` }}
        >
          {rows.map((row) => (
            <GalleryCard
              key={row.id}
              workspaceId={workspaceId}
              row={row}
              showIcon={showIcons}
              wrap={wrapProperties}
              props={cardProps}
              color={colors?.get(row.id)}
              coverUrl={withCover ? coverOf(row) : null}
              coverClass={withCover ? COVER_HEIGHT[size] : null}
              readOnly={readOnly}
              editTitle={editTitleOf === row.id}
              typed={editTitleOf === row.id ? typed : undefined}
              onTitle={onCardTitle}
              onDelete={onCardDelete}
            />
          ))}
          {!readOnly && (
            <button
              type="button"
              onClick={add}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-fg-muted hover:bg-bg-hover hover:text-fg",
                withCover ? "min-h-40" : "min-h-20",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("gallery.new")}
            </button>
          )}
        </div>
        {!rows.length && readOnly && <p className="py-10 text-center text-sm text-fg-muted">{t("gallery.empty")}</p>}
      </div>
    </QuickAddContext>
  );
}

const GalleryCard = memo(function GalleryCard({
  workspaceId,
  row,
  showIcon,
  wrap,
  props,
  color,
  coverUrl,
  coverClass,
  readOnly,
  editTitle,
  typed,
  onTitle,
  onDelete,
}: {
  workspaceId: string;
  row: Row;
  /** The view shows rows' page icons (see ViewConfig showIcons). */
  showIcon: boolean;
  /** Long values take more lines instead of being cut off (see ViewConfig wrapProperties). */
  wrap: boolean;
  props: Property[];
  /** What color rules color on the card: the card, its name or values. */
  color?: RowColors;
  /** The card's cover image, if it has one. */
  coverUrl: string | null;
  /** Height of the cover area, or null when the view shows no covers. */
  coverClass: string | null;
  readOnly?: boolean;
  editTitle: boolean;
  /** Typed before the title editor opened. */
  typed?: string;
  onTitle: (row: Row, title: string) => void;
  onDelete: (rowId: string) => void;
}) {
  const tc = useTranslations("common");
  const opener = useRowOpener(workspaceId);
  const isOpen = useIsOpenRow(opener, row.id);
  const shown = shownValues(props, row);
  // A cover that fails to load leaves the plain cover area instead of a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  const cover = coverUrl && coverUrl !== failed ? coverUrl : null;

  return (
    <div
      role="link"
      tabIndex={0}
      {...openRowProps(opener, row.id, !editTitle)}
      onClick={(e) => !editTitle && opener.open(row.id, e)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !editTitle && e.target === e.currentTarget) opener.open(row.id, e);
      }}
      className={cn(
        "board-card group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg",
        colorMarkClass(color?.row),
        isOpen && "outline-2 outline-accent/60",
      )}
    >
      {coverClass && (
        <div className={cn(coverClass, "shrink-0 overflow-hidden border-b border-border bg-bg-subtle")}>
          {cover ? (
            // Covers are arbitrary URLs from row bodies: plain img, no optimizer, no referrer.
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailed(cover)}
              className="h-full w-full object-cover"
            />
          ) : (
            showIcon &&
            row.icon && (
              <div className="flex h-full items-center justify-center">
                <PageIcon icon={row.icon} className="text-4xl" />
              </div>
            )
          )}
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        {editTitle ? (
          <CardTitleInput initial={typed || row.title} onDone={(title) => onTitle(row, title)} />
        ) : (
          <div className="flex min-w-0 gap-1.5 pe-6 text-sm leading-5 font-medium">
            {showIcon && row.icon && (!coverClass || cover) && <span className="shrink-0">{row.icon}</span>}
            <span className={cn("min-w-0 break-words", !row.title && "text-fg-faint", cellMarkClass(color, "title"))}>
              {pageLabel(row.title, tc("untitled"))}
            </span>
          </div>
        )}
        {shown.length > 0 && (
          <div className="mt-2 flex flex-col items-start gap-1.5 text-xs">
            {shown.map((p) => (
              <div
                key={p.id}
                className={cn("flex max-w-full min-w-0 text-fg-muted", wrap ? "items-start" : "items-center", cellMarkClass(color, p.id))}
                title={p.name}
              >
                <RowValue prop={p} row={row} wrap={wrap} />
              </div>
            ))}
          </div>
        )}
      </div>
      {!readOnly && !editTitle && (
        <RowMenu
          opener={opener}
          rowId={row.id}
          onDelete={() => onDelete(row.id)}
          className={cn("absolute inset-e-1.5", coverClass ? "top-1.5" : "top-2")}
        />
      )}
    </div>
  );
});

/** The "…" menu on gallery cards and list rows: open the row, or move it to the trash. */
export function RowMenu({
  opener,
  rowId,
  onDelete,
  className,
}: {
  opener: RowOpener;
  rowId: string;
  onDelete: () => void;
  className?: string;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <div className={className} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        ref={menu.ref}
        type="button"
        aria-label={t("gallery.rowActions")}
        title={t("gallery.rowActions")}
        onClick={menu.toggle}
        className={cn(
          "board-card flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:text-fg focus-visible:visible",
          menu.open ? "visible" : "invisible group-hover:visible pointer-coarse:visible",
        )}
      >
        <Ellipsis className="h-3.5 w-3.5" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <OpenRowItems opener={opener} rowId={rowId} onDone={menu.close} />
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
    </div>
  );
}

"use client";

import { Ellipsis, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn, MenuItem, MenuSeparator, PageIcon } from "@/components/ui";
import type { CardSize } from "@/db/schema/app";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView } from "@/lib/properties";
import { firstImageFile } from "@/lib/files";
import { coverProperty, galleryCover } from "@/lib/views";
import { CardTitleInput } from "./board-view";
import { Floating, useFloating } from "./floating";
import { RowValue, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
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
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
}) {
  const t = useTranslations("database");
  const { editTitleOf, typed, create: createNew, stopEditing, saveTitle, quick } = useNewRow(api, view, properties);
  const size = view.config.cardSize ?? "medium";
  // Covers come from each row's body (first_image) or from a files property's first image.
  const source = galleryCover(view.config);
  const coverProp = coverProperty(view.config, properties);
  const withCover = source === "first_image" || coverProp !== null;
  const coverOf = (row: Row) => (coverProp ? (firstImageFile(row.properties[coverProp.id])?.url ?? null) : (row.cover ?? null));
  const cardProps = properties.filter((p) => !isHiddenInView(view, p));

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
              props={cardProps}
              coverUrl={withCover ? coverOf(row) : null}
              coverClass={withCover ? COVER_HEIGHT[size] : null}
              readOnly={readOnly}
              editTitle={editTitleOf === row.id}
              typed={typed}
              onTitle={(title) => {
                stopEditing();
                if (title !== row.title) saveTitle(row.id, title);
              }}
              onDelete={() => api.deleteRow(row.id)}
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

function GalleryCard({
  workspaceId,
  row,
  props,
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
  props: Property[];
  /** The card's cover image, if it has one. */
  coverUrl: string | null;
  /** Height of the cover area, or null when the view shows no covers. */
  coverClass: string | null;
  readOnly?: boolean;
  editTitle: boolean;
  /** Typed before the title editor opened. */
  typed?: string;
  onTitle: (title: string) => void;
  onDelete: () => void;
}) {
  const tc = useTranslations("common");
  const router = useRouter();
  const href = `/w/${workspaceId}/p/${row.id}`;
  const shown = shownValues(props, row);
  // A cover that fails to load leaves the plain cover area instead of a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  const cover = coverUrl && coverUrl !== failed ? coverUrl : null;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => !editTitle && router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !editTitle && e.target === e.currentTarget) router.push(href);
      }}
      className="board-card group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg"
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
          <CardTitleInput initial={typed || row.title} onDone={onTitle} />
        ) : (
          <div className="flex min-w-0 gap-1.5 pr-6 text-sm leading-5 font-medium">
            {row.icon && (!coverClass || cover) && <span className="shrink-0">{row.icon}</span>}
            <span className={cn("min-w-0 break-words", !row.title && "text-fg-faint")}>
              {pageLabel(row.title, tc("untitled"))}
            </span>
          </div>
        )}
        {shown.length > 0 && (
          <div className="mt-2 flex flex-col items-start gap-1.5 text-xs">
            {shown.map((p) => (
              <div key={p.id} className="flex max-w-full min-w-0 items-center text-fg-muted" title={p.name}>
                <RowValue prop={p} row={row} />
              </div>
            ))}
          </div>
        )}
      </div>
      {!readOnly && !editTitle && (
        <RowMenu
          href={href}
          onDelete={onDelete}
          className={cn("absolute right-1.5", coverClass ? "top-1.5" : "top-2")}
        />
      )}
    </div>
  );
}

/** The "…" menu on gallery cards and list rows: open the row, or move it to the trash. */
export function RowMenu({ href, onDelete, className }: { href: string; onDelete: () => void; className?: string }) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const router = useRouter();
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
        <MenuItem
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          onClick={() => {
            menu.close();
            router.push(href);
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
    </div>
  );
}

"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView } from "@/lib/properties";
import { Floating } from "./floating";
import { RowValue, shownValues } from "./property-cell";
import type { Property, Row, View } from "./types";

/** The rows behind a bar, point, slice or pivot cell, as links, with the properties the view shows. */
export function GroupRows({
  workspaceId,
  view,
  properties,
  title,
  value,
  rows,
  anchor,
  onClose,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  title: string;
  value: string;
  rows: Row[];
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const t = useTranslations("database.chart");
  const tc = useTranslations("common");
  const shown = properties.filter((p) => !isHiddenInView(view, p));
  return (
    <Floating open anchor={anchor} onClose={onClose}>
      <div className="w-72 max-w-[calc(100vw-2rem)]" aria-label={t("rowsIn", { group: title })} role="dialog">
        <div className="px-2 pt-1 pb-1.5">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-xs text-fg-muted">
            {value} · {t("rowCount", { count: rows.length })}
          </div>
        </div>
        {!rows.length && <p className="px-2 pb-2 text-xs text-fg-faint">{t("noRows")}</p>}
        <ul className="max-h-72 overflow-y-auto">
          {rows.map((row) => {
            const chips = shownValues(shown, row);
            return (
              <li key={row.id}>
                <Link
                  href={`/w/${workspaceId}/p/${row.id}`}
                  onClick={onClose}
                  className="flex min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-sm hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <PageIcon icon={row.icon} className="shrink-0" />
                    <span className={cn("truncate", !row.title && "text-fg-faint")}>{pageLabel(row.title, tc("untitled"))}</span>
                  </span>
                  {chips.length > 0 && (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 ps-6 text-xs text-fg-muted">
                      {chips.map((p) => (
                        <span key={p.id} className="flex min-w-0 items-center" title={p.name}>
                          <RowValue prop={p} row={row} />
                        </span>
                      ))}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Floating>
  );
}

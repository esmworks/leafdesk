"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui";
import { pivotColumnProperty, pivotData, pivotMeasure, pivotRowProperty } from "@/lib/pivot";
import { useGroupContext } from "./group-label";
import { GroupRows } from "./group-rows";
import { useMeasureName } from "./measure-name";
import { PivotTable, type OpenedCell } from "./pivot-table";
import type { Property, Row, View } from "./types";

/**
 * A pivot of the view's rows: a row per group of one property, a column per group of another,
 * each cell the view's measure over the rows in both (see lib/pivot). Filters apply (the rows come
 * filtered); sorts only order the rows listed behind a cell. Clicking a cell lists its rows.
 */
export function PivotView({
  workspaceId,
  view,
  properties,
  rows,
  readOnly,
  locked,
  onCreateGroupProperty,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  readOnly?: boolean;
  locked?: boolean;
  onCreateGroupProperty: () => void;
}) {
  const t = useTranslations("database");
  const config = view.config;
  const rowBy = pivotRowProperty(properties, config);
  const columnBy = pivotColumnProperty(properties, config, rowBy);
  const measure = useMemo(() => pivotMeasure(config, properties), [config, properties]);
  const measureName = useMeasureName(measure, properties);
  const rowContext = useGroupContext(rowBy ?? undefined);
  const columnContext = useGroupContext(columnBy ?? undefined);
  const data = useMemo(
    () => (rowBy ? pivotData(rows, { rowBy, columnBy, measure, config, rowContext, columnContext }) : null),
    [rows, rowBy, columnBy, measure, config, rowContext, columnContext],
  );
  const [open, setOpen] = useState<OpenedCell<Row> | null>(null);

  if (!rowBy || !data) {
    return (
      <div className="page-gutter">
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
          <div>
            <p className="text-sm font-medium">{t("pivot.needsGroupTitle")}</p>
            <p className="mt-1 text-sm text-fg-muted">{t("pivot.needsGroupBody")}</p>
          </div>
          {!readOnly && !locked && (
            <Button size="sm" onClick={onCreateGroupProperty}>
              <Plus className="h-3.5 w-3.5" />
              {t("board.addGroupProperty", { name: t("page.defaultGroupProperty") })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-gutter pb-6">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-fg-muted">{t("pivot.empty")}</p>
      ) : (
        <PivotTable
          data={data}
          rowBy={rowBy}
          columnBy={columnBy}
          measure={measure}
          measureName={measureName}
          totals={config.showTotals !== false}
          onOpen={setOpen}
        />
      )}
      {open && (
        <GroupRows
          workspaceId={workspaceId}
          view={view}
          properties={properties}
          title={open.title}
          value={open.value}
          rows={open.cell.rows}
          anchor={open.anchor}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

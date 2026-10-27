"use client";

import { useTranslations } from "next-intl";
import { PivotTable } from "@/components/database/pivot-table";
import type { PublishedPivot } from "@/server/publication";

/** A published pivot: its table, figures only (no rows came along to open). */
export function PublishedPivotTable({ pivot, print = false }: { pivot: PublishedPivot; print?: boolean }) {
  const t = useTranslations("database");
  const tc = useTranslations("database.calculate");
  const named = (id: string | null) => pivot.properties.find((p) => p.id === id);
  const rowBy = named(pivot.rowById);
  const { measure, data } = pivot;
  const measureName =
    measure.kind === "count" ? t("chart.countShort") : t("chart.measureOf", { calculation: tc(`menu.${measure.fn}`), property: named(measure.prop.id)?.name ?? "" });
  if (!data || !rowBy) return <p className="py-2 text-sm text-fg-faint">{t("pivot.needsGroupBody")}</p>;
  if (!pivot.rowCount) return <p className="py-2 text-sm text-fg-faint">{t("pivot.empty")}</p>;
  return (
    <PivotTable
      data={data}
      rowBy={rowBy}
      columnBy={named(pivot.columnById) ?? null}
      measure={measure}
      measureName={measureName}
      totals={pivot.totals}
      print={print}
    />
  );
}

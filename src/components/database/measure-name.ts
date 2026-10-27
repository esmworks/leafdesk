"use client";

import { useTranslations } from "next-intl";
import type { ChartMeasure } from "@/lib/chart";
import type { Property } from "./types";

/** What a chart measures, by name: "Count", or "Sum of Estimate". */
export function useMeasureName(measure: ChartMeasure, properties: Pick<Property, "id" | "name">[]) {
  const t = useTranslations("database");
  const tc = useTranslations("database.calculate");
  return measure.kind === "count"
    ? t("chart.countShort")
    : t("chart.measureOf", { calculation: tc(`menu.${measure.fn}`), property: properties.find((p) => p.id === measure.prop.id)?.name ?? "" });
}

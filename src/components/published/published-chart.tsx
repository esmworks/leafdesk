"use client";

import { useTranslations } from "next-intl";
import { useGroupName } from "@/components/database/group-label";
import { useFormatResult } from "@/components/database/table-calculations";
import type { AggregateResult } from "@/lib/aggregate";
import type { GroupValue } from "@/lib/grouping";
import type { PublishedChart } from "@/server/publication";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/**
 * A published chart's figures: a number chart's value drawn large, any other chart as a table of
 * its groups (and stack series) with their values. `compact`: smaller, for dashboard widgets.
 */
export function PublishedChartFigures({ chart, compact = false, print = false }: { chart: PublishedChart; compact?: boolean; print?: boolean }) {
  const t = useTranslations("database");
  const tc = useTranslations("database.calculate");
  const formatResult = useFormatResult();
  const named = (id: string | null) => chart.properties.find((p) => p.id === id);
  const groupBy = named(chart.groupById);
  const groupName = useGroupName(groupBy);
  const seriesName = useGroupName(named(chart.stackById));
  const { measure, data } = chart;
  const fn = measure.kind === "count" ? "count_all" : measure.fn;
  const options = measure.kind === "count" ? undefined : measure.prop.options;
  const show = (result: AggregateResult | null) => (result ? formatResult(fn, result, options) : "–");
  const measured =
    measure.kind === "count"
      ? t("chart.countShort")
      : t("chart.measureOf", { calculation: tc(`menu.${measure.fn}`), property: named(measure.prop.id)?.name ?? "" });
  const measureName = chart.accumulate ? t(`chart.running.${chart.accumulate}`, { measure: measured }) : measured;
  const nameOf = (g: { key: string; value: GroupValue; other?: boolean }) => (g.other ? t("chart.other") : groupName(g));

  if (chart.chartType === "number") {
    return (
      <div className="min-w-0 py-1">
        <span className={cn("block truncate font-semibold tracking-tight tabular-nums", compact ? "text-3xl" : "text-5xl")}>{show(chart.result)}</span>
        <span className="mt-1 block truncate text-sm text-fg-muted">{measureName}</span>
      </div>
    );
  }
  if (!data) return <p className="py-2 text-sm text-fg-faint">{t("chart.needsGroupBody")}</p>;
  if (!data.groups.length) return <p className="py-2 text-sm text-fg-faint">{t("chart.empty")}</p>;
  const cell = "border-b border-border px-2 py-1.5 text-start align-top";
  return (
    <div className={cn("pb-1", !print && "overflow-x-auto [color-scheme:light_dark]")}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-fg-muted">
            <th scope="col" className={cn(cell, "border-t font-normal")}>
              {groupBy?.name}
            </th>
            <th scope="col" className={cn(cell, "border-t border-s text-end font-normal")}>
              {measureName}
            </th>
            {data.series.map((s) => (
              <th key={s.key} scope="col" className={cn(cell, "border-t border-s text-end font-normal")}>
                {s.other ? t("chart.other") : seriesName(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.groups.map((g) => (
            <tr key={g.key}>
              <th scope="row" className={cn(cell, "font-medium")}>
                {nameOf(g)}
              </th>
              <td className={cn(cell, "border-s text-end tabular-nums")}>{show(g.result)}</td>
              {g.segments.map((s) => (
                <td key={s.key} className={cn(cell, "border-s text-end tabular-nums text-fg-muted")}>
                  {show(s.result)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

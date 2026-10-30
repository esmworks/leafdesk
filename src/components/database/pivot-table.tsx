"use client";

import { useTranslations } from "next-intl";
import type { AggregateResult } from "@/lib/aggregate";
import type { ChartMeasure } from "@/lib/chart";
import type { PivotCell, PivotData } from "@/lib/pivot";
import { GroupLabel, useGroupName, type GroupProp } from "./group-label";
import { useFormatResult } from "./table-calculations";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");
// lib/pivot's pivotRowCount, kept here so published pages' first load doesn't take in the grouping code.
const rowCount = (cell: { rows: unknown[]; count?: number }) => cell.count ?? cell.rows.length;

/** A clicked cell or total: what it is called, its value as shown, and the rows behind it. */
export type OpenedCell<R> = { title: string; value: string; cell: PivotCell<R>; anchor: HTMLElement };

/**
 * A pivot as a table: a row per row group, a column per column group (or one column of values
 * without a column property), totals at the end of each row and under each column when `totals`.
 * Cells with rows open them through `onOpen` (left out where the rows didn't come along: a
 * published page). Published pages, print and the app share it, so values read the same everywhere.
 */
export function PivotTable<R>({
  data,
  rowBy,
  columnBy,
  measure,
  measureName,
  totals,
  onOpen,
  print = false,
}: {
  data: PivotData<R>;
  rowBy: GroupProp;
  columnBy: GroupProp | null;
  measure: ChartMeasure;
  /** What the cells show, by name: "Count", "Sum of Amount". */
  measureName: string;
  totals: boolean;
  onOpen?: (opened: OpenedCell<R>) => void;
  print?: boolean;
}) {
  const t = useTranslations("database");
  const formatResult = useFormatResult();
  const rowName = useGroupName(rowBy);
  const columnName = useGroupName(columnBy);
  const fn = measure.kind === "count" ? "count_all" : measure.fn;
  // A sum or an average of amounts shows as an amount (currency, decimals); counts stay plain.
  const options = measure.kind === "count" ? undefined : measure.prop.options;
  const show = (result: AggregateResult | null) => (result ? formatResult(fn, result, options) : "–");
  const total = t("pivot.total");
  const columns = columnBy ? data.columns : [];
  const withTotals = totals && columns.length > 0;

  const head = "border-b border-border px-2.5 py-1.5 text-start align-bottom font-normal text-fg-muted";
  const sticky = !print && "sticky inset-s-0 z-[1] bg-bg";
  const cellClass = "border-b border-s border-border p-0 text-end tabular-nums";

  const value = (cell: PivotCell<R>, title: string, strong?: boolean) => {
    const empty = rowCount(cell) === 0;
    const shown = show(cell.result);
    if (empty) return <span className="block px-2.5 py-1.5 text-fg-faint">–</span>;
    if (!onOpen) return <span className={cn("block px-2.5 py-1.5", strong && "font-medium")}>{shown}</span>;
    return (
      <button
        type="button"
        aria-label={t("chart.openRows", { group: title, value: shown })}
        onClick={(e) => onOpen({ title, value: `${measureName}: ${shown}`, cell, anchor: e.currentTarget })}
        className={cn(
          "block w-full px-2.5 py-1.5 text-end outline-none hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
          strong && "font-medium",
        )}
      >
        {shown}
      </button>
    );
  };
  const cellTitle = (row: string, column: string) => t("chart.segment", { group: row, series: column });

  return (
    <div className={cn(!print && "overflow-x-auto [color-scheme:light_dark]")}>
      <table className="w-max min-w-full border-collapse border-t border-border text-sm">
        <caption className="sr-only">
          {columnBy
            ? t("pivot.caption", { measure: measureName, rows: rowBy.name, columns: columnBy.name })
            : t("pivot.captionRows", { measure: measureName, rows: rowBy.name })}
        </caption>
        <thead>
          <tr>
            <th scope="col" className={cn(head, sticky, "min-w-32")}>
              {columnBy ? `${rowBy.name} / ${columnBy.name}` : rowBy.name}
            </th>
            {columnBy ? (
              columns.map((c) => (
                <th key={c.key} scope="col" className={cn(head, "max-w-48 border-s text-end")}>
                  <span className="flex justify-end">
                    <GroupLabel prop={columnBy} group={c} />
                  </span>
                </th>
              ))
            ) : (
              <th scope="col" className={cn(head, "border-s text-end")}>
                {measureName}
              </th>
            )}
            {withTotals && (
              <th scope="col" className={cn(head, "border-s bg-bg-subtle text-end font-medium text-fg")}>
                {total}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const name = rowName(r);
            return (
              <tr key={r.key}>
                <th scope="row" className={cn("border-b border-border px-2.5 py-1.5 text-start font-normal", sticky)}>
                  <span className="flex max-w-64 min-w-0">
                    <GroupLabel prop={rowBy} group={r} />
                  </span>
                </th>
                {columns.length
                  ? r.cells.map((cell, i) => (
                      <td key={columns[i].key} className={cellClass}>
                        {value(cell, cellTitle(name, columnName(columns[i])))}
                      </td>
                    ))
                  : !columnBy && <td className={cellClass}>{value(r.total, name)}</td>}
                {withTotals && <td className={cn(cellClass, "bg-bg-subtle")}>{value(r.total, cellTitle(name, total), true)}</td>}
              </tr>
            );
          })}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="bg-bg-subtle">
              <th scope="row" className={cn("border-b border-border px-2.5 py-1.5 text-start font-medium", sticky, !print && "bg-bg-subtle")}>
                {total}
              </th>
              {columns.map((c) => (
                <td key={c.key} className={cellClass}>
                  {value(c.total, cellTitle(total, columnName(c)), true)}
                </td>
              ))}
              <td className={cellClass}>{value(data.grand, total, true)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {data.moreColumns > 0 && <p className="mt-2 text-xs text-fg-faint">{t("pivot.moreColumns", { count: data.moreColumns })}</p>}
    </div>
  );
}

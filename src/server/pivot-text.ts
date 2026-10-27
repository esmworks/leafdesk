import { getTranslations } from "next-intl/server";
import type { PropertyType } from "@/db/schema/app";
import type { AggregateResult } from "@/lib/aggregate";
import type { ChartMeasure } from "@/lib/chart";
import type { GroupValue } from "@/lib/grouping";
import { pageLabel } from "@/lib/labels";
import { calculationFormat, formatInFormat } from "@/lib/number-format";
import { pivotRowCount, type PivotCell, type PivotData } from "@/lib/pivot";
import { STATUS_GROUPS, type StatusGroup } from "@/lib/property-types";

/**
 * A pivot (lib/pivot) as the cells of a table, for files made on the server: a view's CSV, HTML or
 * PDF download and a PDF of a page showing one. Groups are named and values written in the
 * reader's language, as the app shows them (components/database/pivot-table); a CSV keeps plain
 * numbers for spreadsheets to add up.
 */

export type PivotTexts = {
  total: string;
  untitled: string;
  unknownPerson: string;
  checked: string;
  unchecked: string;
  noValue: (property: string) => string;
  status: Record<StatusGroup, string>;
  quarter: (quarter: number, year: string) => string;
  count: string;
  measureOf: (fn: string, property: string) => string;
};

const ENGLISH: PivotTexts = {
  total: "Total",
  untitled: "Untitled",
  unknownPerson: "Unknown person",
  checked: "Checked",
  unchecked: "Unchecked",
  noValue: (property) => `No ${property}`,
  status: { todo: "To-do", in_progress: "In progress", done: "Complete" },
  quarter: (quarter, year) => `Q${quarter} ${year}`,
  count: "Count",
  measureOf: (fn, property) => `${fn} of ${property}`,
};

/** The texts in the request's language (English outside a request). */
export async function pivotTexts(): Promise<PivotTexts> {
  try {
    const [t, tc] = await Promise.all([getTranslations("database"), getTranslations("common")]);
    return {
      total: t("pivot.total"),
      untitled: tc("untitled"),
      unknownPerson: t("person.unknown"),
      checked: t("group.checked"),
      unchecked: t("group.unchecked"),
      noValue: (property) => t("board.noValue", { property }),
      status: Object.fromEntries(STATUS_GROUPS.map((g) => [g, t(`statusGroups.${g}`)])) as Record<StatusGroup, string>,
      quarter: (quarter, year) => t("group.quarter", { quarter, year }),
      count: t("chart.countShort"),
      measureOf: (fn, property) => t("chart.measureOf", { calculation: t(`calculate.menu.${fn as "sum"}`), property }),
    };
  } catch {
    return ENGLISH;
  }
}

/** A group's name, as group-label's useGroupName gives it. */
function groupName(value: GroupValue, property: string, texts: PivotTexts, locale: string): string {
  const date = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  switch (value.kind) {
    case "none":
      return texts.noValue(property);
    case "option":
      return value.option.name || texts.untitled;
    case "status_group":
      return texts.status[value.group];
    case "person":
      return value.person.name || texts.unknownPerson;
    case "checkbox":
      return value.checked ? texts.checked : texts.unchecked;
    case "relation":
      return pageLabel(value.row.title, texts.untitled);
    case "text":
      return value.text;
    case "date": {
      const start = new Date(`${value.start}T00:00:00Z`);
      switch (value.by) {
        case "day":
          return date({ year: "numeric", month: "short", day: "numeric" }).format(start);
        case "week":
          return date({ year: "numeric", month: "short", day: "numeric" }).formatRange(start, new Date(`${value.end}T00:00:00Z`));
        case "month":
          return date({ year: "numeric", month: "long" }).format(start);
        case "quarter":
          return texts.quarter(Math.floor(start.getUTCMonth() / 3) + 1, date({ year: "numeric" }).format(start));
        case "year":
          return date({ year: "numeric" }).format(start);
      }
    }
  }
}

export type PivotShape = {
  data: PivotData<unknown>;
  rowBy: { name: string; type: PropertyType };
  columnBy: { name: string; type: PropertyType } | null;
  measure: ChartMeasure;
  /** The measured property's name, when the cells calculate over one. */
  measured?: string;
  totals: boolean;
};

/**
 * The pivot's header and rows, laid out as the app's table: the row groups down, the column
 * groups across (one column of values without a column property), totals last when shown. Empty
 * cells (no rows) are null. `raw`: values as plain numbers, for a CSV.
 */
export function pivotCells(pivot: PivotShape, texts: PivotTexts, locale: string, raw: boolean): { header: string[]; cells: (string | number | null)[][] } {
  const { data, rowBy, columnBy, measure, totals } = pivot;
  const fn = measure.kind === "count" ? "count_all" : measure.fn;
  const format = measure.kind === "count" ? undefined : calculationFormat(fn, measure.prop.options);
  const measureName = measure.kind === "count" ? texts.count : texts.measureOf(measure.fn, pivot.measured ?? "");
  // Averages and medians rarely end evenly: two decimals, as the app shows them.
  const auto = fn === "average" || fn === "median" ? 2 : undefined;
  const number = (value: number, options: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value);
  const show = (result: AggregateResult | null): string | number | null => {
    if (!result || result.format === "date") return null;
    return raw ? result.value : formatInFormat(result.value, format, number, auto);
  };
  const cell = (c: PivotCell<unknown>) => (pivotRowCount(c) === 0 ? null : show(c.result));
  const columns = columnBy ? data.columns : [];
  const withTotals = totals && columns.length > 0;
  const header = columnBy
    ? [`${rowBy.name} / ${columnBy.name}`, ...columns.map((c) => groupName(c.value, columnBy.name, texts, locale)), ...(withTotals ? [texts.total] : [])]
    : [rowBy.name, measureName];
  const cells = data.rows.map((r) => [
    groupName(r.value, rowBy.name, texts, locale),
    ...(columnBy ? r.cells.map(cell) : [cell(r.total)]),
    ...(withTotals ? [cell(r.total)] : []),
  ]);
  if (totals) cells.push([texts.total, ...columns.map((c) => cell(c.total)), cell(data.grand)]);
  return { header, cells };
}

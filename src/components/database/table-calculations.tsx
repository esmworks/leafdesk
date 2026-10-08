"use client";

import { Check, ChevronDown } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useMemo } from "react";
import { cn, MenuItem, MenuSeparator } from "@/components/ui";
import type { PropertyOptions } from "@/db/schema/app";
import {
  aggregate,
  aggregateFunctions,
  aggregateGroup,
  isAggregateFn,
  type AggregateFn,
  type AggregateResult,
} from "@/lib/aggregate";
import { Floating, useFloating } from "./floating";
import { calculationFormat } from "@/lib/number-format";
import { useFormatDate, useFormatNumber } from "./property-cell";
import type { Row } from "./types";

/** A table column as calculations see it: the Name column is `{ key: "title", type: "title" }`. */
export type CalculationColumn = { key: string; name: string; type: string; options?: PropertyOptions };

/** Averages and medians rarely end evenly; two decimals are plenty in a footer. */
const ROUNDED: AggregateFn[] = ["average", "median"];

/**
 * Shows a calculation's result. `options`: the column's property options, so a sum or an average
 * of amounts shows as an amount and of percentages as a percentage (counts stay plain numbers).
 */
export function useFormatResult() {
  const t = useTranslations("database.calculate");
  const format = useFormatter();
  const formatNumber = useFormatNumber();
  const formatDate = useFormatDate();
  return (fn: AggregateFn, result: AggregateResult, options?: PropertyOptions) => {
    switch (result.format) {
      case "number":
        return formatNumber(result.value, calculationFormat(fn, options), ROUNDED.includes(fn) ? 2 : undefined);
      case "percent":
        return format.number(result.value, { style: "percent", maximumFractionDigits: 1 });
      case "date":
        return formatDate(result.value);
      case "days":
        return t("days", { count: result.value });
    }
  };
}

/**
 * The table footer: one calculation cell per column, lined up with the table's columns (`offset`
 * is the width of the row-controls column before the first one). Hidden for viewers when the view
 * has no calculations to show.
 */
export function CalculationRow({
  offset,
  columns,
  rows,
  calculations,
  readOnly,
  onChange,
}: {
  offset: number;
  /** `frozen`: a frozen column's position and look (see TableView). */
  columns: (CalculationColumn & { width: number; frozen?: { style?: React.CSSProperties; className?: string } })[];
  rows: Row[];
  calculations: Record<string, string> | undefined;
  readOnly?: boolean;
  onChange: (key: string, fn: AggregateFn | null) => void;
}) {
  if (readOnly && !columns.some((c) => calculations?.[c.key])) return null;
  // With frozen columns the space before them stays put too, so nothing shows through it.
  const frozen = columns.some((c) => c.frozen?.className);
  return (
    // As wide as the table, so frozen cells have the whole width to stay put in.
    <div className="group/footer flex w-max" style={{ paddingLeft: frozen ? 0 : offset }}>
      {frozen && <div className="sticky left-0 z-30 shrink-0 bg-bg" style={{ width: offset }} />}
      {columns.map((column) => (
        <div
          key={column.key}
          className={cn("shrink-0", column.frozen?.className)}
          style={{ width: column.width, ...column.frozen?.style }}
        >
          <CalculationCell
            column={column}
            rows={rows}
            fn={calculations?.[column.key]}
            readOnly={readOnly}
            onChange={(fn) => onChange(column.key, fn)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * One footer cell: the column's calculation over the rows the view shows, or a "Calculate" button
 * that appears on hover while none is set. Viewers see the result but can't change it.
 */
export function CalculationCell({
  column,
  rows,
  fn: stored,
  readOnly,
  onChange,
}: {
  column: CalculationColumn;
  rows: Row[];
  fn: string | undefined;
  readOnly?: boolean;
  onChange: (fn: AggregateFn | null) => void;
}) {
  const t = useTranslations("database.calculate");
  const menu = useFloating<HTMLButtonElement>();
  const formatResult = useFormatResult();
  const available = aggregateFunctions(column.type);
  // A stored calculation the column no longer offers shows as unset.
  const fn = isAggregateFn(stored) && available.includes(stored) ? stored : null;
  const result = useMemo(
    () => (fn ? aggregate(rows, column.key, fn, { type: column.type, options: column.options }) : null),
    [rows, column.key, column.type, column.options, fn],
  );

  if (readOnly && !fn) return null;
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        disabled={readOnly}
        onClick={menu.toggle}
        aria-label={fn ? undefined : t("calculateColumn", { column: column.name })}
        className={cn(
          "flex h-[33px] w-full min-w-0 items-center justify-end gap-1 px-2 text-xs text-fg-muted hover:bg-bg-hover disabled:hover:bg-transparent",
          // Unset cells stay out of the way until the table is hovered (or on touch screens).
          !fn &&
            !menu.open &&
            "opacity-0 group-hover/footer:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        {fn ? (
          <>
            <span className="truncate text-fg-faint">{t(`label.${fn}`)}</span>
            <span className="shrink-0 tabular-nums text-fg">{result ? formatResult(fn, result, column.options) : "–"}</span>
          </>
        ) : (
          <>
            <span className="truncate">{t("calculate")}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </>
        )}
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end" className="max-h-80 overflow-y-auto">
        <CalculationOptions
          type={column.type}
          fn={fn}
          onPick={(next) => {
            menu.close();
            if (next !== fn) onChange(next);
          }}
        />
      </Floating>
    </>
  );
}

/**
 * The calculations a column of `type` offers, "None" first, with the current one (`fn`) ticked:
 * the footer cell's menu and the column header's Calculate menu.
 */
export function CalculationOptions({
  type,
  fn: stored,
  onPick,
}: {
  type: string;
  fn: string | null | undefined;
  onPick: (fn: AggregateFn | null) => void;
}) {
  const t = useTranslations("database.calculate");
  const available = aggregateFunctions(type);
  const fn = isAggregateFn(stored) && available.includes(stored) ? stored : null;
  return (
    <>
      <MenuItem icon={fn ? <span /> : <Check className="h-3.5 w-3.5" />} onClick={() => onPick(null)}>
        {t("none")}
      </MenuItem>
      {available.map((option, i) => (
        <Fragment key={option}>
          {(i === 0 || aggregateGroup(option) !== aggregateGroup(available[i - 1])) && <MenuSeparator />}
          <MenuItem
            active={option === fn}
            icon={option === fn ? <Check className="h-3.5 w-3.5" /> : <span />}
            onClick={() => onPick(option)}
          >
            {t(`menu.${option}`)}
          </MenuItem>
        </Fragment>
      ))}
    </>
  );
}

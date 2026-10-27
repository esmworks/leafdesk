"use client";

import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@/components/ui";
import type { AggregateFn, AggregateResult } from "@/lib/aggregate";
import {
  canStack,
  isStackable,
  chartAccumulateOf,
  chartData,
  chartGroupProperty,
  chartMeasure,
  chartTypeOf,
  countsWholeNumbers,
  isAdditive,
  MAX_CHART_SERIES,
  measureRows,
  niceTicks,
  rowCountOf,
  type ChartData,
  type ChartGroup,
  type ChartMeasure,
  type ChartSeries,
} from "@/lib/chart";
import type { GroupValue } from "@/lib/grouping";
import { SELECT_COLORS, statusColor } from "@/lib/properties";
import { useGroupContext, useGroupName } from "./group-label";
import { GroupRows } from "./group-rows";
import { useMeasureName } from "./measure-name";
import { useFormatResult } from "./table-calculations";
import { calculationFormat, durationText, isDuration, isRating, numberFormatOptions } from "@/lib/number-format";
import type { Property, Row, View } from "./types";

export { useMeasureName };

/**
 * A chart of the view's rows: bars, a line or a donut over the groups of a property, each group
 * measured by counting its rows or by a calculation over one property (see lib/chart). Filters
 * apply (the rows come filtered); sorts only order the rows listed behind a bar. Hovering or
 * focusing a mark shows its value, clicking it lists its rows. Hand-drawn SVG: a chart library
 * would be most of the bundle for four shapes.
 */
export function ChartView({
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
  const groupBy = chartGroupProperty(properties, config);
  const measure = useMemo(() => chartMeasure(config, properties), [config, properties]);
  const chartType = chartTypeOf(config);
  const stackBy =
    (!chartAccumulateOf(config, groupBy, measure) &&
      properties.find((p) => p.id === config.stackBy && p.id !== groupBy?.id && isStackable(p.type) && canStack(chartType, measure))) ||
    null;
  const context = useGroupContext(groupBy ?? undefined);
  const stackContext = useGroupContext(stackBy ?? undefined);
  const data = useMemo(
    () => (groupBy && chartType !== "number" ? chartData(rows, { groupBy, stackBy, measure, config, context, stackContext }) : null),
    [rows, groupBy, stackBy, measure, config, context, stackContext, chartType],
  );

  if (chartType === "number") {
    return (
      <div className="page-gutter pb-6">
        <NumberChart workspaceId={workspaceId} view={view} properties={properties} measure={measure} rows={rows} />
      </div>
    );
  }

  if (!groupBy || !data) {
    return (
      <div className="page-gutter">
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
          <div>
            <p className="text-sm font-medium">{t("chart.needsGroupTitle")}</p>
            <p className="mt-1 text-sm text-fg-muted">{t("chart.needsGroupBody")}</p>
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
        <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-fg-muted">
          {t("chart.empty")}
        </p>
      ) : (
        <Chart
          workspaceId={workspaceId}
          view={view}
          properties={properties}
          groupBy={groupBy}
          stackBy={stackBy}
          measure={measure}
          data={data}
        />
      )}
    </div>
  );
}

/**
 * One value drawn large with what it measures under it: a number chart, or a dashboard widget
 * showing one. Clicking it lists the rows behind it when `onOpen` is given.
 */
export function NumberFigure({
  value,
  label,
  openLabel,
  onOpen,
  compact,
}: {
  value: string;
  /** What the value is; left out where the value's title already says it. */
  label?: string;
  openLabel?: string;
  onOpen?: (anchor: HTMLElement) => void;
  compact?: boolean;
}) {
  const figure = (
    <>
      <span className={cn("block truncate font-semibold tracking-tight tabular-nums", compact ? "text-3xl" : "text-5xl")}>{value}</span>
      {label && <span className="mt-1 block truncate text-sm text-fg-muted">{label}</span>}
    </>
  );
  if (!onOpen) return <div className="min-w-0 py-1">{figure}</div>;
  return (
    <button
      type="button"
      aria-label={openLabel}
      onClick={(e) => onOpen(e.currentTarget)}
      className="block max-w-full min-w-0 rounded-md py-1 text-start outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
    >
      {figure}
    </button>
  );
}

/** A number chart: the view's measure over all of its rows; clicking it lists them. */
function NumberChart({
  workspaceId,
  view,
  properties,
  measure,
  rows,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  measure: ChartMeasure;
  rows: Row[];
}) {
  const t = useTranslations("database");
  const formatResult = useFormatResult();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const name = useMeasureName(measure, properties);
  const fn: AggregateFn = measure.kind === "count" ? "count_all" : measure.fn;
  const result = useMemo(() => measureRows(rows, measure), [rows, measure]);
  const value = result ? formatResult(fn, result, measure.kind === "count" ? undefined : measure.prop.options) : "–";
  return (
    <>
      <NumberFigure value={value} label={name} openLabel={t("chart.openRows", { group: name, value })} onOpen={setOpen} />
      {open && (
        <GroupRows
          workspaceId={workspaceId}
          view={view}
          properties={properties}
          title={name}
          value={value}
          rows={rows}
          anchor={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** What a mark stands for: a group, or one segment of a stacked bar. */
type Target = { group: ChartGroup<unknown>; segment?: number };

/** The rows behind a clicked mark, for a chart that draws its own list (see Chart `renderRows`). */
export type OpenedMark = {
  /** The group's key, and the segment's series key on a stacked bar. */
  groupKey: string;
  seriesKey?: string;
  title: string;
  value: string;
  anchor: HTMLElement;
  onClose: () => void;
};

/**
 * The marks, tooltips, legend and accessible table of a chart over `data`. Its rows are only
 * counted (rowCountOf) and listed when a mark is clicked: by default from the data itself, or by
 * `renderRows` for data sent without them (a dashboard widget).
 */
export function Chart<R>({
  workspaceId,
  view,
  properties,
  groupBy,
  stackBy,
  measure,
  data,
  renderRows,
}: {
  workspaceId: string;
  view: Pick<View, "config"> & Partial<View>;
  properties: Pick<Property, "id" | "name">[];
  groupBy: Pick<Property, "name" | "type">;
  stackBy: Pick<Property, "name"> | null;
  measure: ChartMeasure;
  data: ChartData<R>;
  renderRows?: (opened: OpenedMark) => ReactNode;
}) {
  const t = useTranslations("database");
  const config = view.config;
  const chartType = chartTypeOf(config);
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const groupName = useGroupName(groupBy);
  const seriesName = useGroupName(stackBy ?? { name: "" });
  const formatResult = useFormatResult();
  const format = useFormatter();
  const [hover, setHover] = useState<(Target & { x: number; y: number }) | null>(null);
  const [open, setOpen] = useState<(Target & { anchor: HTMLElement }) | null>(null);
  // A live update may redraw the chart under the pointer; the hovered mark may be gone.
  useEffect(() => setHover(null), [data]);
  const hoverSeries = hover?.segment !== undefined ? data.series[hover.segment] : undefined;

  const fn: AggregateFn = measure.kind === "count" ? "count_all" : measure.fn;
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  const measured = useMeasureName(measure, properties);
  // Running totals say so wherever the value is named: the axis, tooltips, row lists, the table.
  const measureName = accumulate ? t(`chart.running.${accumulate}`, { measure: measured }) : measured;
  const nameOf = (g: { key: string; value: GroupValue; other?: boolean }) => (g.other ? t("chart.other") : groupName(g));
  const seriesLabel = (s: ChartSeries | undefined) => (!s ? "" : s.other ? t("chart.other") : seriesName(s));
  // A sum or average of amounts (or percentages) shows in the property's number format.
  const options = measure.kind === "count" ? undefined : measure.prop.options;
  const unit = calculationFormat(fn, options);
  const show = (result: AggregateResult | null) => (result ? formatResult(fn, result, options) : "–");
  const tick = (value: number) => {
    if (data.format === "percent") return format.number(value, { style: "percent", maximumFractionDigits: 1 });
    const notation = Math.abs(value) >= 10000 ? "compact" : "standard";
    // Durations as hours and minutes, ratings as the number of stars.
    if (isDuration(unit)) return durationText(value, unit);
    if (isRating(unit)) return format.number(value, { maximumFractionDigits: 1 });
    // Axis labels drop the fixed decimals: "₺1.000", not "₺1.000,00".
    if (unit) return format.number(value, { ...numberFormatOptions(unit, 2), minimumFractionDigits: 0, notation });
    return format.number(value, { notation, maximumFractionDigits: 2 });
  };
  // A donut slice's share is of the slices together (a row with two tags is in two slices).
  const sliced = data.groups.reduce((sum, g) => sum + Math.max(0, g.amount), 0);
  const stacked = data.series.length > 0;
  const colorOf = markColor;

  const describe = (target: Target) => {
    const { group, segment } = target;
    if (segment !== undefined) {
      const s = group.segments[segment];
      return t("chart.openRows", { group: t("chart.segment", { group: nameOf(group), series: seriesLabel(data.series[segment]) }), value: show(s.result) });
    }
    return t("chart.openRows", { group: nameOf(group), value: show(group.result) });
  };

  // Tooltips sit above the mark, inside the chart's box.
  const pointAt = (target: Target, el: Element) => {
    const outer = box.current?.getBoundingClientRect();
    if (!outer) return;
    const mark = (el.querySelector(".mark") ?? el).getBoundingClientRect();
    setHover({ ...target, x: mark.left + mark.width / 2 - outer.left, y: mark.top - outer.top });
  };
  // Floating only measures and hit-tests its anchor, which SVG elements support as well.
  const openRows = (target: Target, el: Element) => setOpen({ ...target, anchor: el as HTMLElement });

  const handlers = (target: Target): React.SVGProps<SVGGElement> => ({
    role: "button",
    tabIndex: 0,
    "aria-label": describe(target),
    className: "cursor-pointer outline-none [&:focus-visible_.hit]:stroke-accent",
    onMouseEnter: (e) => pointAt(target, e.currentTarget),
    onMouseLeave: () => setHover(null),
    onFocus: (e) => pointAt(target, e.currentTarget),
    onBlur: () => setHover(null),
    onClick: (e) => openRows(target, e.currentTarget),
    onKeyDown: (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openRows(target, e.currentTarget);
    },
  });

  // A segment of a stacked bar answers hover and clicks on its own; its bar keeps keyboard focus.
  const segment = (group: ChartGroup<unknown>, index: number): React.SVGProps<SVGPathElement> => ({
    onMouseEnter: (e) => {
      e.stopPropagation();
      pointAt({ group, segment: index }, e.currentTarget);
    },
    onClick: (e) => {
      e.stopPropagation();
      openRows({ group, segment: index }, e.currentTarget);
    },
  });

  const common = { data, handlers, segment, pointAt, openRows, clearHover: () => setHover(null), colorOf, tick, show, nameOf, width, measure, showValues: !!config.showValues };
  const chartTitle = t("chart.title", { type: t(`chart.types.${chartType}`), measure: measureName, property: groupBy.name });

  return (
    <div className="flex flex-col gap-3">
      <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
        <p id={titleId} className="sr-only">
          {chartTitle}
        </p>
        {width > 0 &&
          (chartType === "donut" ? (
            <Donut {...common} titleId={titleId} total={data.total} legend={config.showLegend !== false} center={isAdditive(measure)} measureName={measureName} />
          ) : chartType === "horizontal_bar" ? (
            <HorizontalBars {...common} titleId={titleId} stacked={stacked} />
          ) : chartType === "line" ? (
            <Line {...common} titleId={titleId} />
          ) : (
            <Columns {...common} titleId={titleId} stacked={stacked} />
          ))}
        {hover && (
          <Tooltip x={hover.x} y={hover.y} width={width}>
            <div className="font-medium">{nameOf(hover.group)}</div>
            {hoverSeries && hover.segment !== undefined ? (
              <TooltipLine color={colorOf(hoverSeries.value, hoverSeries.slot, hoverSeries.other, false)}>
                {seriesLabel(hoverSeries)}: <b className="font-medium">{show(hover.group.segments[hover.segment].result)}</b>
              </TooltipLine>
            ) : (
              <div>
                {measureName}: <b className="font-medium">{show(hover.group.result)}</b>
              </div>
            )}
            {hover.group.period && <div>{t("chart.thisPeriod", { value: show(hover.group.period.result) })}</div>}
            {chartType === "donut" && sliced > 0 && isAdditive(measure) && (
              <div className="text-fg-muted">
                {t("chart.share", { share: format.number(Math.max(0, hover.group.amount) / sliced, { style: "percent", maximumFractionDigits: 1 }) })}
              </div>
            )}
            <div className="text-fg-muted">
              {t("chart.rowCount", {
                count: rowCountOf(hoverSeries && hover.segment !== undefined ? hover.group.segments[hover.segment] : hover.group),
              })}
            </div>
          </Tooltip>
        )}
      </div>

      {stacked && (
        <Legend
          items={data.series.map((s) => ({ key: s.key, label: seriesLabel(s), color: colorOf(s.value, s.slot, s.other, false) }))}
        />
      )}

      <table className="sr-only">
        <caption>{chartTitle}</caption>
        <thead>
          <tr>
            <th scope="col">{groupBy.name}</th>
            <th scope="col">{measureName}</th>
            {data.series.map((s) => (
              <th key={s.key} scope="col">
                {seriesLabel(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.groups.map((g) => (
            <tr key={g.key}>
              <th scope="row">{nameOf(g)}</th>
              <td>{show(g.result)}</td>
              {g.segments.map((s) => (
                <td key={s.key}>{show(s.result)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {open &&
        (() => {
          const title =
            open.segment !== undefined
              ? t("chart.segment", { group: nameOf(open.group), series: seriesLabel(data.series[open.segment]) })
              : nameOf(open.group);
          const value = `${measureName}: ${show(open.segment !== undefined ? open.group.segments[open.segment].result : open.group.result)}`;
          const onClose = () => setOpen(null);
          if (renderRows) {
            const seriesKey = open.segment !== undefined ? data.series[open.segment]?.key : undefined;
            return renderRows({ groupKey: open.group.key, ...(seriesKey !== undefined ? { seriesKey } : {}), title, value, anchor: open.anchor, onClose });
          }
          // Without renderRows the data carries its rows: ChartView's.
          return (
            <GroupRows
              workspaceId={workspaceId}
              view={view as View}
              properties={properties as Property[]}
              title={title}
              value={value}
              rows={(open.segment !== undefined ? open.group.segments[open.segment].rows : open.group.rows) as Row[]}
              anchor={open.anchor}
              onClose={onClose}
            />
          );
        })()}
    </div>
  );
}

/** The chart box's width, following resizes (the chart redraws to fit instead of scaling). */
function useWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * A mark's fill: select and status groups take their option's hue; a single series is one color
 * (the categories are on the axis); several series use the categorical colors by slot. No value
 * and "Other" are gray.
 */
function markColor(value: GroupValue, slot: number, other: boolean | undefined, single: boolean) {
  if (other || value.kind === "none") return "var(--chart-none)";
  if (value.kind === "option") {
    const color = SELECT_COLORS.includes(value.option.color as (typeof SELECT_COLORS)[number]) ? value.option.color : "gray";
    return `var(--chart-${color})`;
  }
  if (value.kind === "status_group") return `var(--chart-${statusColor(value.group)})`;
  if (single) return "var(--chart-1)";
  return `var(--chart-${(slot % MAX_CHART_SERIES) + 1})`;
}

type MarkProps = {
  data: ChartData<unknown>;
  handlers: (target: Target) => React.SVGProps<SVGGElement>;
  segment: (group: ChartGroup<unknown>, index: number) => React.SVGProps<SVGPathElement>;
  pointAt: (target: Target, el: Element) => void;
  openRows: (target: Target, el: Element) => void;
  clearHover: () => void;
  colorOf: (value: GroupValue, slot: number, other: boolean | undefined, single: boolean) => string;
  tick: (value: number) => string;
  show: (result: AggregateResult | null) => string;
  nameOf: (g: { key: string; value: GroupValue; other?: boolean }) => string;
  width: number;
  measure: ChartMeasure;
  showValues: boolean;
  titleId: string;
};

const FONT = 11;
/** A rough width of UI text at the axis font size; enough to decide what fits. */
const textWidth = (text: string) => text.length * FONT * 0.6;

/** `text` cut to about `max` pixels. */
function fit(text: string, max: number) {
  if (textWidth(text) <= max) return text;
  const chars = Math.max(1, Math.floor(max / (FONT * 0.6)) - 1);
  return `${text.slice(0, chars)}…`;
}

/** The value axis: round ticks over the data's range, whole numbers for counts. */
function scaleOf(data: ChartData<unknown>, measure: ChartMeasure, count: number) {
  const ticks = niceTicks(data.min, data.max, count, data.format === "number" && countsWholeNumbers(measure));
  return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1] };
}

/**
 * A bar from `base` to `end` along the value axis with its far end rounded (4px, less for thin
 * bars), square at the baseline. `across` and `size` place it on the other axis.
 */
function barPath(vertical: boolean, base: number, end: number, across: number, size: number) {
  const length = Math.abs(end - base);
  const r = Math.min(4, size / 2, length);
  const s = end < base ? 1 : -1;
  if (vertical) {
    const x = across;
    const w = size;
    return `M${x},${base}V${end + s * r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + s * r}V${base}Z`;
  }
  const y = across;
  const h = size;
  return `M${base},${y}H${end + s * r}Q${end},${y} ${end},${y + r}V${y + h - r}Q${end},${y + h} ${end + s * r},${y + h}H${base}Z`;
}

/**
 * Where each segment of a bar goes: positive ones stack away from the baseline, negative ones
 * the other way, with a 2px gap between touching segments. Returns [start, end] per segment in
 * value units, null for empty ones, and which one ends each direction (it gets the round end).
 */
function stackSpans(amounts: number[]) {
  let up = 0;
  let down = 0;
  const spans = amounts.map((a): [number, number] | null => {
    if (!a) return null;
    if (a > 0) return [up, (up += a)];
    return [down, (down += a)];
  });
  const lastUp = amounts.findLastIndex((a) => a > 0);
  const lastDown = amounts.findLastIndex((a) => a < 0);
  return { spans, ends: new Set([lastUp, lastDown]) };
}

const GAP = 2;

/** Vertical bars (columns), stacked when the chart has series. Scrolls sideways when groups don't fit. */
function Columns({ data, handlers, segment, colorOf, tick, show, nameOf, width, measure, showValues, titleId, stacked }: MarkProps & { stacked: boolean }) {
  const height = 300;
  const { ticks, lo, hi } = scaleOf(data, measure, 5);
  const left = Math.max(28, ...ticks.map((v) => textWidth(tick(v)))) + 10;
  const top = showValues ? 22 : 12;
  const bottom = 28;
  const n = data.groups.length;
  const plotW = Math.max(width - left - 8, n * 36);
  const band = plotW / n;
  const barW = Math.min(band * 0.62, 48);
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (height - top - bottom);
  const zero = y(0);
  const svgW = left + plotW + 8;
  const single = !stacked && !data.groups.some((g) => g.value.kind === "option" || g.value.kind === "status_group");
  // Every label gets the band it sits in; past that, every k-th label shows (the tooltip names all).
  const every = Math.max(1, Math.ceil(44 / band));

  // Plots are drawn in screen coordinates, so their axes run left to right in every language.
  return (
    <div dir="ltr" className="overflow-x-auto">
      <svg width={svgW} height={height} role="group" aria-labelledby={titleId} className="block text-fg-muted" style={{ fontSize: FONT }}>
        <Grid ticks={ticks} tick={tick} y={y} left={left} right={svgW - 8} />
        {data.groups.map((g, i) => {
          const x = left + band * i + (band - barW) / 2;
          const color = colorOf(g.value, g.slot, g.other, single);
          const { spans, ends } = stackSpans(g.segments.map((s) => s.amount));
          const totalAmount = stacked ? g.segments.reduce((sum, s) => sum + s.amount, 0) : g.amount;
          return (
            <g key={g.key} {...handlers({ group: g })}>
              <rect className="hit" x={left + band * i} y={top} width={band} height={height - top - bottom} fill="transparent" strokeWidth={2} rx={4} />
              {stacked ? (
                <g className="mark">
                  {g.segments.map((s, j) => {
                    const span = spans[j];
                    if (!span) return null;
                    const series = data.series[j];
                    const end = ends.has(j) ? y(span[1]) : y(span[1]) + (span[1] > span[0] ? GAP : -GAP);
                    return (
                      <path
                        key={s.key}
                        d={barPath(true, y(span[0]), end, x, barW)}
                        fill={colorOf(series.value, series.slot, series.other, false)}
                        {...segment(g, j)}
                      />
                    );
                  })}
                  {/* Keeps the focus outline and tooltip anchored to the whole bar. */}
                  <rect x={x} y={Math.min(y(totalAmount), zero)} width={barW} height={Math.abs(zero - y(totalAmount))} fill="none" />
                </g>
              ) : (
                g.result && Math.abs(y(g.amount) - zero) >= 0.5 && <path className="mark" d={barPath(true, zero, y(g.amount), x, barW)} fill={color} />
              )}
              {!g.result && <rect className="mark" x={x} y={zero} width={barW} height={0} />}
              {showValues && g.result && (
                <text x={x + barW / 2} y={totalAmount >= 0 ? y(totalAmount) - 6 : y(totalAmount) + 14} textAnchor="middle" className="fill-fg">
                  {stacked ? tick(totalAmount) : show(g.result)}
                </text>
              )}
              {i % every === 0 && (
                <text x={left + band * (i + 0.5)} y={height - bottom + 16} textAnchor="middle" className="fill-fg-muted">
                  {fit(nameOf(g), band * every - 6)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={left} x2={svgW - 8} y1={zero} y2={zero} stroke="var(--chart-axis)" />
      </svg>
    </div>
  );
}

/** Horizontal bars: one row per group with its name on the left, stacked when the chart has series. */
function HorizontalBars({
  data,
  handlers,
  segment,
  colorOf,
  tick,
  show,
  nameOf,
  width,
  measure,
  showValues,
  titleId,
  stacked,
}: MarkProps & { stacked: boolean }) {
  const rowH = 32;
  const barH = 20;
  const top = 4;
  const bottom = 24;
  const n = data.groups.length;
  const height = top + n * rowH + bottom;
  const labelW = Math.min(Math.max(...data.groups.map((g) => textWidth(nameOf(g)))) + 14, Math.max(80, width * 0.35), 200);
  const right = showValues ? 56 : 24;
  const plotW = Math.max(80, width - labelW - right);
  const { ticks, lo, hi } = scaleOf(data, measure, Math.max(2, Math.min(6, Math.floor(plotW / 70))));
  const x = (v: number) => labelW + ((v - lo) / (hi - lo)) * plotW;
  const zero = x(0);
  const single = !stacked && !data.groups.some((g) => g.value.kind === "option" || g.value.kind === "status_group");

  return (
    <svg width={width} height={height} role="group" aria-labelledby={titleId} className="block text-fg-muted" style={{ fontSize: FONT, direction: "ltr" }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={top} y2={height - bottom} stroke="var(--chart-grid)" />
          <text x={x(v)} y={height - 8} textAnchor="middle" className="fill-fg-muted tabular-nums">
            {tick(v)}
          </text>
        </g>
      ))}
      {data.groups.map((g, i) => {
        const y = top + i * rowH + (rowH - barH) / 2;
        const color = colorOf(g.value, g.slot, g.other, single);
        const { spans, ends } = stackSpans(g.segments.map((s) => s.amount));
        const totalAmount = stacked ? g.segments.reduce((sum, s) => sum + s.amount, 0) : g.amount;
        return (
          <g key={g.key} {...handlers({ group: g })}>
            <rect className="hit" x={0} y={top + i * rowH} width={width} height={rowH} fill="transparent" strokeWidth={2} rx={4} />
            <text x={labelW - 10} y={y + barH / 2 + 4} textAnchor="end" className="fill-fg">
              {fit(nameOf(g), labelW - 12)}
            </text>
            {stacked ? (
              <g className="mark">
                {g.segments.map((s, j) => {
                  const span = spans[j];
                  if (!span) return null;
                  const series = data.series[j];
                  const end = ends.has(j) ? x(span[1]) : x(span[1]) - (span[1] > span[0] ? GAP : -GAP);
                  return (
                    <path
                      key={s.key}
                      d={barPath(false, x(span[0]), end, y, barH)}
                      fill={colorOf(series.value, series.slot, series.other, false)}
                      {...segment(g, j)}
                    />
                  );
                })}
              </g>
            ) : (
              g.result && Math.abs(x(g.amount) - zero) >= 0.5 && <path className="mark" d={barPath(false, zero, x(g.amount), y, barH)} fill={color} />
            )}
            {showValues && g.result && (
              <text
                x={totalAmount >= 0 ? x(totalAmount) + 6 : x(totalAmount) - 6}
                y={y + barH / 2 + 4}
                textAnchor={totalAmount >= 0 ? "start" : "end"}
                className="fill-fg tabular-nums"
              >
                {stacked ? tick(totalAmount) : show(g.result)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={zero} x2={zero} y1={top} y2={height - bottom} stroke="var(--chart-axis)" />
    </svg>
  );
}

/** A 2px line through the groups with a light wash below; groups without a value break the line. */
function Line({ data, handlers, tick, show, nameOf, width, measure, showValues, titleId }: MarkProps) {
  const height = 300;
  const { ticks, lo, hi } = scaleOf(data, measure, 5);
  const left = Math.max(28, ...ticks.map((v) => textWidth(tick(v)))) + 10;
  const top = showValues ? 24 : 14;
  const bottom = 28;
  const n = data.groups.length;
  const plotW = Math.max(width - left - 8, n * 28);
  const band = plotW / n;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (height - top - bottom);
  const cx = (i: number) => left + band * (i + 0.5);
  const zero = y(0);
  const svgW = left + plotW + 8;
  const every = Math.max(1, Math.ceil(44 / band));
  // Runs of consecutive groups with a value; each run is one stretch of line. Rows without a value
  // aren't a step along the axis: their point stands apart.
  const runs: number[][] = [];
  data.groups.forEach((g, i) => {
    if (!g.result || g.value.kind === "none") return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });
  const path = (run: number[]) => run.map((i, k) => `${k ? "L" : "M"}${cx(i)},${y(data.groups[i].amount)}`).join("");

  return (
    <div dir="ltr" className="overflow-x-auto">
      <svg width={svgW} height={height} role="group" aria-labelledby={titleId} className="block text-fg-muted" style={{ fontSize: FONT }}>
        <Grid ticks={ticks} tick={tick} y={y} left={left} right={svgW - 8} />
        <line x1={left} x2={svgW - 8} y1={zero} y2={zero} stroke="var(--chart-axis)" />
        {runs.map((run) => (
          <g key={run[0]}>
            <path d={`${path(run)}L${cx(run[run.length - 1])},${zero}L${cx(run[0])},${zero}Z`} fill="var(--chart-1)" opacity={0.1} />
            <path d={path(run)} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {data.groups.map((g, i) => (
          <g key={g.key} {...handlers({ group: g })}>
            <rect className="hit" x={left + band * i} y={top} width={band} height={height - top - bottom} fill="transparent" strokeWidth={2} rx={4} />
            {g.result && (
              <circle className="mark" cx={cx(i)} cy={y(g.amount)} r={4} fill="var(--chart-1)" stroke="var(--bg)" strokeWidth={2} />
            )}
            {showValues && g.result && (
              <text x={cx(i)} y={y(g.amount) - 10} textAnchor="middle" className="fill-fg">
                {show(g.result)}
              </text>
            )}
            {i % every === 0 && (
              <text x={cx(i)} y={height - bottom + 16} textAnchor="middle" className="fill-fg-muted">
                {fit(nameOf(g), band * every - 6)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** A donut: slices in group order clockwise from the top, the total in the middle, a legend beside or below. */
function Donut({
  data,
  handlers,
  pointAt,
  openRows,
  clearHover,
  colorOf,
  show,
  nameOf,
  width,
  showValues,
  titleId,
  total,
  legend,
  center,
  measureName,
}: MarkProps & { total: number; legend: boolean; center: boolean; measureName: string }) {
  const format = useFormatter();
  const side = legend && width >= 560;
  const size = Math.max(160, Math.min(side ? 300 : 260, width));
  const r1 = size / 2 - 4;
  const r0 = r1 * 0.62;
  const c = size / 2;
  // Shares are of the slices together, so the ring closes; a row in two slices counts in both.
  // The center shows `total`, where it counts once.
  const sliced = data.groups.reduce((sum, g) => sum + Math.max(0, g.amount), 0);
  let angle = 0;
  const slices = data.groups.map((g) => {
    const share = sliced > 0 ? Math.max(0, g.amount) / sliced : 0;
    const start = angle;
    angle += share * Math.PI * 2;
    return { g, start, end: angle, share };
  });
  // Separators only between slices you can see: a single full ring is drawn in two halves, without a seam.
  const drawn = slices.filter((s) => s.end - s.start > 0).length;

  return (
    <div className={cn("flex gap-6", side ? "flex-row items-center" : "flex-col items-center")}>
      <svg width={size} height={size} role="group" aria-labelledby={titleId} className="block shrink-0" style={{ fontSize: FONT, direction: "ltr" }}>
        <circle cx={c} cy={c} r={(r0 + r1) / 2} fill="none" stroke="var(--chart-grid)" strokeWidth={r1 - r0} />
        {slices.map(({ g, start, end }) =>
          end - start > 0 ? (
            <g key={g.key} {...handlers({ group: g })}>
              <path
                className="mark hit"
                d={arcPath(c, r0, r1, start, end)}
                fill={colorOf(g.value, g.slot, g.other, false)}
                stroke="var(--bg)"
                strokeWidth={drawn > 1 ? 2 : 0}
              />
            </g>
          ) : null,
        )}
        {center && (
          <>
            <text x={c} y={c + 2} textAnchor="middle" className="fill-fg" style={{ fontSize: 22, fontWeight: 600 }}>
              {show({ format: "number", value: total })}
            </text>
            <text x={c} y={c + 20} textAnchor="middle" className="fill-fg-muted">
              {fit(measureName, r0 * 1.6)}
            </text>
          </>
        )}
      </svg>
      {legend && (
        <ul className={cn("flex min-w-0 flex-col gap-1 text-sm", side ? "max-w-sm" : "w-full max-w-sm")}>
          {slices.map(({ g, share }) => (
            <li key={g.key}>
              {/* The slices are the keyboard stops; the legend repeats them for the mouse. */}
              <button
                type="button"
                tabIndex={-1}
                onMouseEnter={(e) => pointAt({ group: g }, e.currentTarget)}
                onMouseLeave={clearHover}
                onClick={(e) => openRows({ group: g }, e.currentTarget)}
                className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-start hover:bg-bg-hover"
              >
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorOf(g.value, g.slot, g.other, false) }} />
                <span className="min-w-0 flex-1 truncate">{nameOf(g)}</span>
                {showValues && <span className="shrink-0 tabular-nums text-fg-muted">{show(g.result)}</span>}
                {sliced > 0 && (
                  <span className="w-12 shrink-0 text-end tabular-nums text-fg-faint">
                    {format.number(share, { style: "percent", maximumFractionDigits: 0 })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A ring slice between radii `r0` and `r1`, angles clockwise from 12 o'clock. A full ring is drawn as two halves. */
function arcPath(c: number, r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) return arcPath(c, r0, r1, 0, Math.PI) + arcPath(c, r0, r1, Math.PI, Math.PI * 2);
  const p = (r: number, a: number) => `${c + r * Math.sin(a)},${c - r * Math.cos(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

/** Hairline value gridlines with their labels on the left. */
function Grid({ ticks, tick, y, left, right }: { ticks: number[]; tick: (v: number) => string; y: (v: number) => number; left: number; right: number }) {
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" />
          <text x={left - 8} y={y(v) + 4} textAnchor="end" className="fill-fg-muted tabular-nums">
            {tick(v)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // Kept inside the chart's box so it never runs off a phone screen.
  const left = Math.max(90, Math.min(x, width - 90));
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 max-w-[180px] -translate-x-1/2 -translate-y-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left, top: Math.max(0, y - 8) }}
    >
      {children}
    </div>
  );
}

function TooltipLine({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
      <span>{children}</span>
    </div>
  );
}

function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

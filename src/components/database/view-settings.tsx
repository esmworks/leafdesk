"use client";

import { ChartBarBig, ChartColumnBig, ChartLine, ChartPie, Check, ListTree, Plus, SlidersHorizontal, Waypoints } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cn, MenuItem, MenuSeparator } from "@/components/ui";
import type { ChartAccumulate, ChartSort, GroupDateBy, ViewConfig } from "@/db/schema/app";
import type { AggregateFn } from "@/lib/aggregate";
import {
  canAccumulate,
  canStack,
  isStackable,
  CHART_ACCUMULATES,
  CHART_SORTS,
  CHART_TYPES,
  chartAggregateFunctions,
  chartAggregateFunctionsOf,
  chartAccumulateOf,
  chartGroupProperty,
  chartMeasure,
  chartSortOf,
  chartTypeOf,
} from "@/lib/chart";
import { GROUP_DATE_BY, groupDateByOf } from "@/lib/grouping";
import { isGroupable } from "@/lib/properties";
import { holdsTimestamp } from "@/lib/property-types";
import { CARD_SIZES, coverProperty, galleryCover } from "@/lib/views";
import { parentProperty, SUB_ITEMS_DISPLAYS, subItemsDisplay, subItemsProperty } from "@/lib/sub-items";
import {
  blockedByProperty,
  blockingProperty,
  DEPENDENCY_SHIFTS,
  dependencySettings,
  type DependencyInput,
} from "@/lib/dependencies";
import { Floating, useFloating } from "./floating";
import { PropertyTypeIcon } from "./property-icons";
import type { Property, View } from "./types";
import { NativeSelect } from "./view-bar";

/** Date properties a timeline can start bars at (created and edited times are read-only there). */
export function timelineStartProps(properties: Property[]) {
  return properties.filter((p) => p.type === "date" || holdsTimestamp(p.type));
}

/**
 * The timeline's start and end properties: the saved ones, else the first date property. An end
 * equal to the start (or not a date) counts as none.
 */
export function timelineDates(view: View, properties: Property[]) {
  const starts = timelineStartProps(properties);
  const start =
    starts.find((p) => p.id === view.config.dateBy) ?? starts.find((p) => p.type === "date") ?? null;
  const end =
    properties.find((p) => p.id === view.config.endDateBy && p.type === "date" && p.id !== start?.id) ?? null;
  return { start, end };
}

/** The timeline's swimlane property, when it has one that can still group. */
export function timelineGroupProperty(view: View, properties: Property[]) {
  return properties.find((p) => p.id === view.config.groupBy && isGroupable(p.type)) ?? null;
}

/** Views that can show sub-items nested under their parent (see lib/sub-items). */
const NESTING_VIEWS = new Set<View["type"]>(["table", "list", "timeline"]);

/** Turns dependencies on or off, or changes their settings (see lib/dependencies). */
export type DependenciesHandler = (on: boolean, input?: { propertyId?: string; settings?: DependencyInput }) => void;

/**
 * Layout settings of gallery, timeline and chart views (card size and cover; dates, swimlanes and
 * table; the chart), sub-items in table, list and timeline views, and dependencies in timelines.
 */
export function ViewLayoutMenu({
  view,
  properties,
  onConfig,
  onCreateDateProperty,
  onSubItems,
  onDependencies,
  readOnly,
  locked,
}: {
  view: View;
  properties: Property[];
  onConfig: (config: ViewConfig) => void;
  onCreateDateProperty: () => void;
  /** Turns sub-items on (new properties, or the given relation) or off; missing when the user can't. */
  onSubItems?: (on: boolean, propertyId?: string) => void;
  /** Missing when the user can't change dependencies. */
  onDependencies?: DependenciesHandler;
  readOnly?: boolean;
  locked?: boolean;
}) {
  const t = useTranslations("database.layout");
  const menu = useFloating<HTMLButtonElement>();
  const nesting = NESTING_VIEWS.has(view.type);
  // A table or list without sub-items has nothing to set but turning them on.
  if (readOnly || (!nesting && view.type !== "gallery" && view.type !== "chart")) return null;
  if (nesting && view.type !== "timeline" && !parentProperty(properties) && (!onSubItems || locked)) return null;
  const config = view.config;
  const set = (patch: ViewConfig) => onConfig({ ...config, ...patch });

  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        title={t("label")}
        aria-label={t("label")}
        onClick={menu.toggle}
        className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <div className={cn("max-h-[70vh] overflow-y-auto", view.type === "chart" ? "w-72 max-w-[calc(100vw-2rem)]" : "w-64")}>
          {view.type === "chart" ? (
            <ChartSettings view={view} properties={properties} onSet={set} />
          ) : view.type === "gallery" ? (
            <>
              <Heading>{t("cardSize")}</Heading>
              {CARD_SIZES.map((size) => (
                <Choice key={size} active={(config.cardSize ?? "medium") === size} onClick={() => set({ cardSize: size })}>
                  {t(`cardSizes.${size}`)}
                </Choice>
              ))}
              <MenuSeparator />
              <Heading>{t("cover")}</Heading>
              <Choice active={galleryCover(config) === "first_image"} onClick={() => set({ cover: { source: "first_image" } })}>
                {t("covers.first_image")}
              </Choice>
              {/* Each files property: its first image (see lib/views coverProperty). */}
              {properties
                .filter((p) => p.type === "files")
                .map((p) => (
                  <Choice
                    key={p.id}
                    active={coverProperty(config, properties)?.id === p.id}
                    onClick={() => set({ cover: { source: "property", propertyId: p.id } })}
                  >
                    {t("covers.property", { name: p.name })}
                  </Choice>
                ))}
              <Choice
                active={galleryCover(config) === "none" || (galleryCover(config) === "property" && !coverProperty(config, properties))}
                onClick={() => set({ cover: { source: "none" } })}
              >
                {t("covers.none")}
              </Choice>
            </>
          ) : view.type === "timeline" ? (
            <TimelineSettings
              view={view}
              properties={properties}
              locked={locked}
              onSet={set}
              onCreateDateProperty={() => {
                menu.close();
                onCreateDateProperty();
              }}
            />
          ) : null}
          {nesting && (
            <SubItemsSettings
              view={view}
              properties={properties}
              separated={view.type === "timeline"}
              onSet={set}
              onSubItems={
                onSubItems && !locked
                  ? (on, propertyId) => {
                      menu.close();
                      onSubItems(on, propertyId);
                    }
                  : undefined
              }
            />
          )}
          {view.type === "timeline" && onDependencies && !locked && (
            <DependencySettings
              view={view}
              properties={properties}
              onDependencies={(on, input) => {
                // Turning them on or off closes the menu; changing a setting leaves it open.
                if (!on || !blockedByProperty(properties) || input?.propertyId) menu.close();
                onDependencies(on, input);
              }}
            />
          )}
        </div>
      </Floating>
    </>
  );
}

/**
 * Sub-items: how the view shows them while they're on, and turning them on (with new properties
 * or a relation of the database with itself the user already has) or off.
 */
function SubItemsSettings({
  view,
  properties,
  separated,
  onSet,
  onSubItems,
}: {
  view: View;
  properties: Property[];
  separated?: boolean;
  onSet: (patch: ViewConfig) => void;
  onSubItems?: (on: boolean, propertyId?: string) => void;
}) {
  const t = useTranslations("database.subItems");
  const parent = parentProperty(properties);
  const dependencies = [blockedByProperty(properties)?.id, blockingProperty(properties)?.id];
  const selfRelations = properties.filter(
    (p) => p.type === "relation" && p.options.relation?.databaseId === p.databaseId && !dependencies.includes(p.id),
  );
  if (!parent && !onSubItems) return null;
  const display = subItemsDisplay(view.config, parent);
  return (
    <>
      {separated && <MenuSeparator />}
      <Heading>{t("heading")}</Heading>
      {parent ? (
        <>
          {SUB_ITEMS_DISPLAYS.map((d) => (
            <Choice key={d} active={display === d} onClick={() => onSet({ subItems: d })}>
              {t(`displays.${d}`)}
            </Choice>
          ))}
          {onSubItems && (
            <>
              <MenuSeparator />
              <p className="px-2 pb-1 text-xs text-fg-faint">{t("keptIn", { name: parent.name })}</p>
              <MenuItem icon={<ListTree className="h-3.5 w-3.5" />} onClick={() => onSubItems(false)}>
                {t("turnOff")}
              </MenuItem>
              <p className="px-2 pb-1 text-xs text-fg-faint">{t("turnOffHint")}</p>
            </>
          )}
        </>
      ) : (
        <>
          <p className="px-2 pb-1.5 text-xs text-fg-faint">{t("turnOnHint")}</p>
          <MenuItem icon={<ListTree className="h-3.5 w-3.5" />} onClick={() => onSubItems?.(true)}>
            {t("turnOn")}
          </MenuItem>
          {selfRelations.map((p) => (
            <MenuItem key={p.id} icon={<PropertyTypeIcon type={p.type} />} onClick={() => onSubItems?.(true, p.id)}>
              {t("useExisting", { name: p.name })}
            </MenuItem>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Dependencies: the rule waiting rows follow and the dates they move by while they're on, and
 * turning them on (with new properties or a relation of the database with itself) or off. Turning
 * them on takes this view's dates.
 */
function DependencySettings({
  view,
  properties,
  onDependencies,
}: {
  view: View;
  properties: Property[];
  onDependencies: DependenciesHandler;
}) {
  const t = useTranslations("database.dependencies");
  const by = blockedByProperty(properties);
  const subItems = [parentProperty(properties)?.id, subItemsProperty(properties)?.id];
  const selfRelations = properties.filter(
    (p) => p.type === "relation" && p.options.relation?.databaseId === p.databaseId && !subItems.includes(p.id),
  );
  const dates = timelineDates(view, properties);
  // Created and edited times can't be moved: only date properties count.
  const viewStart = dates.start?.type === "date" ? dates.start : null;
  const viewDates: DependencyInput = { startPropertyId: viewStart?.id ?? null, endPropertyId: (viewStart && dates.end?.id) || null };
  const name = (id: string) => properties.find((p) => p.id === id)?.name ?? "";
  const icon = <Waypoints className="h-3.5 w-3.5" />;

  if (!by) {
    return (
      <>
        <MenuSeparator />
        <Heading>{t("heading")}</Heading>
        <p className="px-2 pb-1.5 text-xs text-fg-faint">{t("turnOnHint")}</p>
        <MenuItem icon={icon} onClick={() => onDependencies(true, { settings: viewDates })}>
          {t("turnOn")}
        </MenuItem>
        {selfRelations.map((p) => (
          <MenuItem
            key={p.id}
            icon={<PropertyTypeIcon type={p.type} />}
            onClick={() => onDependencies(true, { propertyId: p.id, settings: viewDates })}
          >
            {t("useExisting", { name: p.name })}
          </MenuItem>
        ))}
      </>
    );
  }
  const settings = dependencySettings(by, properties);
  const sameDates = settings.start === viewDates.startPropertyId && settings.end === viewDates.endPropertyId;
  return (
    <>
      <MenuSeparator />
      <Heading>{t("heading")}</Heading>
      <p className="px-2 pb-1 text-xs text-fg-faint">{t("rule")}</p>
      {DEPENDENCY_SHIFTS.map((shift) => (
        <Choice key={shift} wrap active={settings.shift === shift} onClick={() => onDependencies(true, { settings: { shift } })}>
          {t(`shifts.${shift}`)}
        </Choice>
      ))}
      <Choice
        wrap
        checkbox
        active={settings.skipWeekends}
        onClick={() => onDependencies(true, { settings: { skipWeekends: !settings.skipWeekends } })}
      >
        {t("skipWeekends")}
      </Choice>
      <MenuSeparator />
      <p className="px-2 pb-1 text-xs text-fg-faint">
        {settings.start
          ? settings.end
            ? t("dates", { start: name(settings.start), end: name(settings.end) })
            : t("startOnly", { start: name(settings.start) })
          : t("noDates")}
      </p>
      {!sameDates && viewStart && (
        <MenuItem icon={icon} onClick={() => onDependencies(true, { settings: viewDates })}>
          {t("useViewDates")}
        </MenuItem>
      )}
      <p className="px-2 pb-1 text-xs text-fg-faint">{t("keptIn", { name: by.name })}</p>
      <MenuItem icon={icon} onClick={() => onDependencies(false)}>
        {t("turnOff")}
      </MenuItem>
      <p className="px-2 pb-1 text-xs text-fg-faint">{t("turnOffHint")}</p>
    </>
  );
}

function TimelineSettings({
  view,
  properties,
  locked,
  onSet,
  onCreateDateProperty,
}: {
  view: View;
  properties: Property[];
  locked?: boolean;
  onSet: (patch: ViewConfig) => void;
  onCreateDateProperty: () => void;
}) {
  const t = useTranslations("database.layout");
  const { start, end } = timelineDates(view, properties);
  const groupBy = timelineGroupProperty(view, properties);
  const starts = timelineStartProps(properties);
  const ends = properties.filter((p) => p.type === "date" && p.id !== start?.id);
  const groupable = properties.filter((p) => isGroupable(p.type));
  const showTable = view.config.showTable !== false;
  return (
    <>
      <Heading>{t("start")}</Heading>
      {starts.map((p) => (
        <MenuItem
          key={p.id}
          active={p.id === start?.id}
          icon={<PropertyTypeIcon type={p.type} />}
          onClick={() => onSet({ dateBy: p.id, endDateBy: p.id === end?.id ? undefined : view.config.endDateBy })}
        >
          {p.name}
        </MenuItem>
      ))}
      {!starts.length && <p className="px-2 pb-1 text-xs text-fg-faint">{t("needsDate")}</p>}
      <MenuSeparator />
      <Heading>{t("end")}</Heading>
      <Choice active={!end} onClick={() => onSet({ endDateBy: undefined })}>
        {t("noEnd")}
      </Choice>
      {ends.map((p) => (
        <MenuItem key={p.id} active={p.id === end?.id} icon={<PropertyTypeIcon type={p.type} />} onClick={() => onSet({ endDateBy: p.id })}>
          {p.name}
        </MenuItem>
      ))}
      {!locked && (
        <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={onCreateDateProperty}>
          {t("newDateProperty")}
        </MenuItem>
      )}
      <MenuSeparator />
      <Heading>{t("groupBy")}</Heading>
      <Choice active={!groupBy} onClick={() => onSet({ groupBy: undefined })}>
        {t("noGrouping")}
      </Choice>
      {groupable.map((p) => (
        <MenuItem key={p.id} active={p.id === groupBy?.id} icon={<PropertyTypeIcon type={p.type} />} onClick={() => onSet({ groupBy: p.id })}>
          {p.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <Toggle on={showTable} onChange={(on) => onSet({ showTable: on })}>
        {t("showTable")}
      </Toggle>
    </>
  );
}

const CHART_ICONS = { bar: ChartColumnBig, horizontal_bar: ChartBarBig, line: ChartLine, donut: ChartPie } as const;

/**
 * Chart settings: the kind of chart, what it groups by (with the date and status grouping), what
 * it measures, running totals over a date, stacking, group order, and what it shows. Running totals
 * go oldest first, unstacked, and keep rows without a date off the axis, so those settings hide.
 */
function ChartSettings({ view, properties, onSet }: { view: View; properties: Property[]; onSet: (patch: ViewConfig) => void }) {
  const t = useTranslations("database");
  const config = view.config;
  const chartType = chartTypeOf(config);
  const groupBy = chartGroupProperty(properties, config);
  const measure = chartMeasure(config, properties);
  const groupable = properties.filter((p) => isGroupable(p.type));
  const measurable = properties.filter((p) => chartAggregateFunctionsOf(p).length > 0);
  const accumulable = canAccumulate(chartType, groupBy, measure);
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  const stackable = canStack(chartType, measure) && !accumulate;
  const stackOptions = properties.filter((p) => isStackable(p.type) && p.id !== groupBy?.id);
  const stackBy = stackOptions.find((p) => p.id === config.stackBy);
  const hiddenGroups = config.hiddenGroups ?? [];
  const showsNoValue = !hiddenGroups.includes("");
  const dates = groupBy && (groupBy.type === "date" || holdsTimestamp(groupBy.type));
  const bars = chartType === "bar" || chartType === "horizontal_bar";

  const setMeasure = (propertyId: string) => {
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) return onSet({ chartAggregate: undefined });
    const fns = chartAggregateFunctionsOf(prop);
    // Numbers are summed and checkboxes counted by default; other types count their values.
    const fn = fns.includes("sum") ? "sum" : fns[0];
    onSet({ chartAggregate: { fn, propertyId: prop.id } });
  };

  return (
    <>
      <Heading>{t("chart.type")}</Heading>
      <div className="grid grid-cols-2 gap-0.5">
        {CHART_TYPES.map((type) => {
          const Icon = CHART_ICONS[type];
          return (
            <MenuItem key={type} active={type === chartType} icon={<Icon className="h-3.5 w-3.5" />} onClick={() => onSet({ chartType: type })}>
              {t(`chart.types.${type}`)}
            </MenuItem>
          );
        })}
      </div>
      <MenuSeparator />
      <SettingRow label={t("chart.groupBy")}>
        <NativeSelect
          label={t("chart.groupBy")}
          value={groupBy?.id ?? ""}
          onChange={(id) => onSet({ groupBy: id, hiddenGroups: undefined, groupOrder: undefined })}
          options={groupable.map((p) => ({ value: p.id, label: p.name }))}
          className="w-36"
        />
      </SettingRow>
      {dates && (
        <SettingRow label={t("group.dateBy")}>
          <NativeSelect
            label={t("group.dateBy")}
            value={groupDateByOf(config)}
            onChange={(v) => onSet({ groupDateBy: v as GroupDateBy })}
            options={GROUP_DATE_BY.map((by) => ({ value: by, label: t(`group.dateByOptions.${by}`) }))}
            className="w-36"
          />
        </SettingRow>
      )}
      {groupBy?.type === "status" && (
        <SettingRow label={t("group.statusBy")}>
          <NativeSelect
            label={t("group.statusBy")}
            value={config.groupStatusBy === "group" ? "group" : "option"}
            onChange={(v) => onSet({ groupStatusBy: v === "group" ? "group" : undefined })}
            options={[
              { value: "option", label: t("group.statusByOptions.option") },
              { value: "group", label: t("group.statusByOptions.group") },
            ]}
            className="w-36"
          />
        </SettingRow>
      )}
      <SettingRow label={t("chart.measure")}>
        <NativeSelect
          label={t("chart.measure")}
          value={measure.kind === "count" ? "" : measure.prop.id}
          onChange={setMeasure}
          options={[{ value: "", label: t("chart.count") }, ...measurable.map((p) => ({ value: p.id, label: p.name }))]}
          className="w-36"
        />
      </SettingRow>
      {measure.kind === "aggregate" && (
        <SettingRow label={t("chart.calculation")}>
          <NativeSelect
            label={t("chart.calculation")}
            value={measure.fn}
            onChange={(fn) => onSet({ chartAggregate: { fn: fn as AggregateFn, propertyId: measure.prop.id } })}
            options={chartAggregateFunctions(measure.prop.type).map((fn) => ({ value: fn, label: t(`calculate.menu.${fn}`) }))}
            className="w-36"
          />
        </SettingRow>
      )}
      {accumulable && (
        <>
          <SettingRow label={t("chart.accumulate")}>
            <NativeSelect
              label={t("chart.accumulate")}
              value={accumulate ?? "none"}
              onChange={(v) => onSet({ chartAccumulate: v === "none" ? undefined : (v as ChartAccumulate) })}
              options={["none" as const, ...CHART_ACCUMULATES].map((mode) => ({ value: mode, label: t(`chart.accumulates.${mode}`) }))}
              className="w-36"
            />
          </SettingRow>
          {accumulate === "remaining" && <p className="px-2 pb-1 text-xs text-fg-faint">{t("chart.remainingHint")}</p>}
        </>
      )}
      {bars && (
        <>
          <SettingRow label={t("chart.stackBy")}>
            <NativeSelect
              label={t("chart.stackBy")}
              value={stackable ? (stackBy?.id ?? "") : ""}
              onChange={(id) => onSet({ stackBy: id || undefined })}
              options={[
                { value: "", label: t("chart.noStack") },
                ...stackOptions.map((p) => ({ value: p.id, label: p.name })),
              ]}
              className="w-36"
              disabled={!stackable}
            />
          </SettingRow>
          {!stackable && <p className="px-2 pb-1 text-xs text-fg-faint">{t(accumulate ? "chart.stackAccumulateHint" : "chart.stackHint")}</p>}
        </>
      )}
      {!accumulate && (
        <SettingRow label={t("chart.sort")}>
          <NativeSelect
            label={t("chart.sort")}
            value={chartSortOf(config)}
            onChange={(v) => onSet({ chartSort: v === "group" ? undefined : (v as ChartSort) })}
            options={CHART_SORTS.map((sort) => ({ value: sort, label: t(`chart.sorts.${sort}`) }))}
            className="w-36"
          />
        </SettingRow>
      )}
      <MenuSeparator />
      <Toggle on={!!config.hideEmptyGroups} onChange={(on) => onSet({ hideEmptyGroups: on || undefined })}>
        {t("group.hideEmpty")}
      </Toggle>
      {!accumulate && (
        <Toggle
          on={showsNoValue}
          onChange={(on) =>
            onSet({ hiddenGroups: on ? hiddenGroups.filter((k) => k !== "") : [...hiddenGroups, ""] })
          }
        >
          {t("chart.showNoValue")}
        </Toggle>
      )}
      <Toggle on={!!config.showValues} onChange={(on) => onSet({ showValues: on || undefined })}>
        {t("chart.showValues")}
      </Toggle>
      {chartType === "donut" && (
        <Toggle on={config.showLegend !== false} onChange={(on) => onSet({ showLegend: on ? undefined : false })}>
          {t("chart.showLegend")}
        </Toggle>
      )}
    </>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 px-2 py-1 text-sm">
      <span className="min-w-0 truncate text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

/** An on/off setting shown as a switch. */
function Toggle({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
    >
      <span className="flex-1">{children}</span>
      <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-bg-active")}>
        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-bg shadow transition-[left]", on ? "left-3.5" : "left-0.5")} />
      </span>
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{children}</div>;
}

/**
 * A menu entry of a one-of-several setting (or an on/off one, `checkbox`), ticked when chosen.
 * `wrap` lets a long label take more lines.
 */
function Choice({
  active,
  onClick,
  wrap,
  checkbox,
  children,
}: {
  active: boolean;
  onClick: () => void;
  wrap?: boolean;
  checkbox?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={checkbox ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={active}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
    >
      <span className={cn("flex-1", !wrap && "truncate")}>{children}</span>
      {active && <Check className="h-3.5 w-3.5 text-fg-muted" />}
    </button>
  );
}

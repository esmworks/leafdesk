"use client";

// The view settings menu, loaded when the menu first opens (see ViewLayoutMenu).

import {
  ArrowLeft,
  ArrowUpDown,
  CalendarDays,
  ChartBarBig,
  ChartColumnBig,
  ChartLine,
  ChartPie,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  Hash,
  IterationCw,
  ListFilter,
  ListTree,
  Palette,
  Plus,
  Rows3,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
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
import {
  GROUP_DATE_BY,
  GROUP_TEXT_BY,
  groupDateByOf,
  groupedType,
  groupNumberFormat,
  groupTextByOf,
  isGroupableProperty,
  isNumberGroupSize,
  SECTIONED_VIEWS,
  subGroupProperty,
  type GroupSettings as ValueSettings,
} from "@/lib/grouping";
import {
  columnSortOf,
  PIVOT_AGGREGATE_FNS,
  pivotAggregateFunctionsOf,
  pivotColumnProperty,
  pivotMeasure,
  pivotRowProperty,
} from "@/lib/pivot";
import { filterRules } from "@/lib/filters";
import { isPercent } from "@/lib/number-format";
import { boardGroupProperty, isHiddenInView, isSortable, TEXT_GROUP_TYPES } from "@/lib/properties";
import { holdsTimestamp } from "@/lib/property-types";
import { DEFAULT_LOAD_LIMIT, LOAD_LIMITS, loadLimitOf } from "@/lib/load-limit";
import {
  AGENDA_PRIORITY_TYPES,
  AGENDA_STATUS_TYPES,
  agendaDateProperty,
  agendaPriorityProperty,
  agendaStatusProperty,
  showsUndated,
} from "@/lib/agenda";
import { CARD_SIZES, coverProperty, galleryCover, OPEN_ROWS, openRowsOf, opensRows, viewDateProperty, viewPlaceProperty } from "@/lib/views";
import { SWITCHABLE_VIEW_TYPES } from "@/lib/view-layouts";
import { parentProperty, SUB_ITEMS_DISPLAYS, subItemsDisplay, subItemsProperty } from "@/lib/sub-items";
import {
  blockedByProperty,
  blockingProperty,
  DEPENDENCY_SHIFTS,
  dependencySettings,
  type DependencyInput,
} from "@/lib/dependencies";
import { PropertyTypeIcon, ViewIcon } from "./property-icons";
import type { Property, View } from "./types";
import { columnsOf, FilterEditor, NativeSelect, PropertiesPanel, SortEditor } from "./view-bar";

import { mapColorProperty, timelineDates, timelineGroupProperty, timelineStartProps, type DependenciesHandler, type ViewLayoutMenuProps } from "./view-settings";

/** Views that can show sub-items nested under their parent (see lib/sub-items). */
const NESTING_VIEWS = new Set<View["type"]>(["table", "list", "timeline"]);

type MenuPage = "main" | "layout" | "properties" | "filter" | "sort" | "group" | "date";
type OptionsProps = Omit<ViewLayoutMenuProps, "readOnly"> & { close: () => void; onColorRules: () => void };

/**
 * What the view settings menu shows (see ViewLayoutMenu): a row for each of the view's layout,
 * properties, filters, sorts and grouping, opening its own page of the menu, then the layout's
 * settings and the view's actions. `close` closes the menu.
 */
export function ViewLayoutOptions(props: OptionsProps) {
  const { view, viewProperties, onConfig, onType, onCreateGroupProperty, onCreateDateProperty, deleted, onDuplicate, onDelete, locked, close } =
    props;
  const t = useTranslations("database");
  const [page, setPage] = useState<MenuPage>("main");
  const config = view.config;
  const columns = columnsOf(viewProperties, t("nameColumn"));
  const filterCount = filterRules(config.filters ?? []).length;
  const sorts = config.sorts ?? [];
  const shown = viewProperties.filter((p) => !isHiddenInView(view, p)).length;
  const groups = view.type === "board" || SECTIONED_VIEWS.has(view.type);
  // Boards always group (by the first fitting property until one is picked); tables, lists and galleries only on request.
  const groupBy =
    view.type === "board"
      ? boardGroupProperty(viewProperties, config.groupBy)
      : viewProperties.find((p) => p.id === config.groupBy && isGroupableProperty(p));
  const dateBy = view.type === "calendar" ? viewDateProperty(config, viewProperties) : undefined;

  const subPage = (title: string, children: ReactNode) => (
    <div className="max-h-[70vh] overflow-y-auto">
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-label={t("viewMenu.back")}
          title={t("viewMenu.back")}
          onClick={() => setPage("main")}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  );

  if (page === "layout" && onType) {
    return subPage(
      t("layout.label"),
      <div className="w-60">
        <p className="px-2 pb-1.5 text-xs text-fg-faint">{t("viewMenu.layoutHint")}</p>
        {SWITCHABLE_VIEW_TYPES.map((type) => (
          <MenuItem
            key={type}
            active={type === view.type}
            icon={<ViewIcon type={type} className="h-3.5 w-3.5" />}
            trailing={type === view.type ? <Check className="h-3.5 w-3.5 text-accent" /> : undefined}
            onClick={() => {
              if (type !== view.type) onType(type);
            }}
          >
            {t(`views.${type}`)}
          </MenuItem>
        ))}
      </div>,
    );
  }
  if (page === "properties") {
    return subPage(t("toolbar.properties"), <PropertiesPanel view={view} properties={viewProperties} onConfig={onConfig} deleted={deleted} />);
  }
  if (page === "filter") {
    return subPage(
      t("toolbar.filter"),
      <FilterEditor
        columns={columns}
        filters={config.filters ?? []}
        combinator={config.filterCombinator ?? "and"}
        onChange={(f, combinator) => onConfig({ ...config, filters: f, filterCombinator: combinator === "or" ? "or" : undefined })}
      />,
    );
  }
  if (page === "sort") {
    return subPage(
      t("toolbar.sort"),
      <SortEditor columns={columns.filter((c) => isSortable(c.type))} sorts={sorts} onChange={(s) => onConfig({ ...config, sorts: s })} />,
    );
  }
  if (page === "group" && groups) {
    return subPage(
      t("toolbar.groupBy"),
      <GroupChoices
        view={view}
        properties={viewProperties}
        groupBy={groupBy}
        onConfig={onConfig}
        onCreate={
          locked
            ? undefined
            : () => {
                close();
                onCreateGroupProperty();
              }
        }
      />,
    );
  }
  if (page === "date" && view.type === "calendar") {
    const dateProps = viewProperties.filter((p) => p.type === "date");
    return subPage(
      t("toolbar.calendarBy"),
      <div className="w-60">
        {dateProps.map((p) => (
          <MenuItem
            key={p.id}
            active={p.id === dateBy?.id}
            icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />}
            onClick={() => onConfig({ ...config, dateBy: p.id })}
          >
            {p.name}
          </MenuItem>
        ))}
        {!dateProps.length && <div className="px-2 pb-1 text-xs text-fg-faint">{t("toolbar.calendarNeedsDate")}</div>}
        {!locked && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                close();
                onCreateDateProperty();
              }}
            >
              {t("toolbar.newDateProperty")}
            </MenuItem>
          </>
        )}
      </div>,
    );
  }

  const row = (to: MenuPage, icon: ReactNode, label: string, value: ReactNode) => (
    <MenuItem
      icon={icon}
      trailing={
        <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
          <span className="max-w-28 truncate">{value}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" />
        </span>
      }
      onClick={() => setPage(to)}
    >
      {label}
    </MenuItem>
  );
  return (
    <div className={cn("max-h-[70vh] overflow-y-auto", view.type === "chart" || view.type === "pivot" ? "w-72 max-w-[calc(100vw-2rem)]" : "w-64")}>
      {onType && SWITCHABLE_VIEW_TYPES.includes(view.type) && row("layout", <ViewIcon type={view.type} className="h-3.5 w-3.5" />, t("layout.label"), t(`views.${view.type}`))}
      {row("properties", <EyeOff className="h-3.5 w-3.5" />, t("toolbar.properties"), t("viewMenu.shown", { count: shown }))}
      {row("filter", <ListFilter className="h-3.5 w-3.5" />, t("toolbar.filter"), filterCount || "")}
      {row("sort", <ArrowUpDown className="h-3.5 w-3.5" />, t("toolbar.sort"), sorts.length || "")}
      {groups && row("group", <Rows3 className="h-3.5 w-3.5" />, t("toolbar.group"), groupBy?.name ?? t("toolbar.noGrouping"))}
      {view.type === "calendar" && row("date", <CalendarDays className="h-3.5 w-3.5" />, t("toolbar.calendarBy"), dateBy?.name ?? "")}
      <MenuSeparator />
      <LayoutSettings {...props} />
      {(onDuplicate || onDelete) && <MenuSeparator />}
      {onDuplicate && (
        <MenuItem
          icon={<Copy className="h-3.5 w-3.5" />}
          title={t("viewTabs.duplicateHint")}
          onClick={() => {
            close();
            onDuplicate();
          }}
        >
          {t("viewTabs.duplicate")}
        </MenuItem>
      )}
      {onDelete && (
        <MenuItem
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => {
            close();
            onDelete();
          }}
        >
          {t("viewTabs.deleteView")}
        </MenuItem>
      )}
    </div>
  );
}

/** What the view groups by, and how (dates, status, empty groups): the menu's Group page. */
function GroupChoices({
  view,
  properties,
  groupBy,
  onConfig,
  onCreate,
}: {
  view: View;
  properties: Property[];
  groupBy: Property | undefined;
  onConfig: (config: ViewConfig) => void;
  /** Creates a select property to group by; missing on a locked database. */
  onCreate?: () => void;
}) {
  const t = useTranslations("database.toolbar");
  const config = view.config;
  const groupProps = properties.filter((p) => isGroupableProperty(p));
  return (
    <div className="w-60">
      {view.type !== "board" && (
        <MenuItem active={!groupBy} icon={<X className="h-3.5 w-3.5" />} onClick={() => groupBy && onConfig({ ...config, groupBy: undefined })}>
          {t("noGrouping")}
        </MenuItem>
      )}
      {groupProps.map((p) => (
        <MenuItem
          key={p.id}
          active={p.id === groupBy?.id}
          icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />}
          onClick={() => onConfig({ ...config, groupBy: p.id })}
        >
          {p.name}
        </MenuItem>
      ))}
      {!groupProps.length && <div className="max-w-60 px-2 pb-1 text-xs text-fg-faint">{t("groupNeedsSelect")}</div>}
      {groupBy && <GroupSettings prop={groupBy} config={config} onConfig={onConfig} />}
      {view.type === "board" && groupBy && <BoardGroupSettings groupBy={groupBy} properties={groupProps} config={config} onConfig={onConfig} />}
      {onCreate && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={onCreate}>
            {t("newSelectProperty")}
          </MenuItem>
        </>
      )}
    </div>
  );
}

/** How the view groups by `prop`: date bucket size, status by option or stage, and empty groups. */
function GroupSettings({
  prop,
  config,
  onConfig,
}: {
  prop: Property;
  config: ViewConfig;
  onConfig: (config: ViewConfig) => void;
}) {
  const t = useTranslations("database.group");
  const type = groupedType(prop);
  const dates = type === "date" || holdsTimestamp(type);
  return (
    <>
      <MenuSeparator />
      <ValueGroupSettings prop={prop} settings={config} onChange={(patch) => onConfig({ ...config, ...patch })} narrow />
      {dates && (
        <label className="flex items-center justify-between gap-3 px-2 py-1 text-sm">
          <span className="text-fg-muted">{t("dateBy")}</span>
          <NativeSelect
            label={t("dateBy")}
            value={groupDateByOf(config)}
            onChange={(v) => onConfig({ ...config, groupDateBy: v as ViewConfig["groupDateBy"] })}
            options={GROUP_DATE_BY.map((by) => ({ value: by, label: t(`dateByOptions.${by}`) }))}
          />
        </label>
      )}
      {prop.type === "status" && (
        <label className="flex items-center justify-between gap-3 px-2 py-1 text-sm">
          <span className="text-fg-muted">{t("statusBy")}</span>
          <NativeSelect
            label={t("statusBy")}
            value={config.groupStatusBy === "group" ? "group" : "option"}
            onChange={(v) => onConfig({ ...config, groupStatusBy: v === "group" ? "group" : undefined })}
            options={[
              { value: "option", label: t("statusByOptions.option") },
              { value: "group", label: t("statusByOptions.group") },
            ]}
          />
        </label>
      )}
      <MenuItem
        icon={config.hideEmptyGroups ? <Check className="h-3.5 w-3.5" /> : <span />}
        onClick={() => onConfig({ ...config, hideEmptyGroups: config.hideEmptyGroups ? undefined : true })}
      >
        {t("hideEmpty")}
      </MenuItem>
    </>
  );
}

/**
 * A board's sub-groups (sections across every column, by a second property) and whether its
 * columns take their option's color.
 */
function BoardGroupSettings({
  groupBy,
  properties,
  config,
  onConfig,
}: {
  groupBy: Property;
  /** The groupable properties. */
  properties: Property[];
  config: ViewConfig;
  onConfig: (config: ViewConfig) => void;
}) {
  const t = useTranslations("database");
  const sub = subGroupProperty(properties, config, groupBy);
  return (
    <>
      <label className="flex items-center justify-between gap-3 px-2 py-1 text-sm">
        <span className="text-fg-muted">{t("group.subGroupBy")}</span>
        <NativeSelect
          label={t("group.subGroupBy")}
          value={sub?.id ?? ""}
          onChange={(id) => onConfig({ ...config, subGroupBy: id || undefined, collapsedSubGroups: undefined })}
          options={[
            { value: "", label: t("toolbar.noGrouping") },
            ...properties.filter((p) => p.id !== groupBy.id).map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </label>
      <MenuItem
        icon={config.colorColumns !== false ? <Check className="h-3.5 w-3.5" /> : <span />}
        onClick={() => onConfig({ ...config, colorColumns: config.colorColumns === false ? undefined : false })}
      >
        {t("group.colorColumns")}
      </MenuItem>
    </>
  );
}

/** The layout's own settings, under the menu's rows (see ViewLayoutOptions). */
function LayoutSettings({
  view,
  properties,
  onConfig,
  onCreateDateProperty,
  onCreatePlaceProperty,
  onSubItems,
  onDependencies,
  onSprints,
  locked,
  close,
  onColorRules,
}: OptionsProps) {
  const t = useTranslations("database.layout");
  const tSprints = useTranslations("database.sprints");
  const rows = opensRows(view.type);
  // A table or list without sub-items has nothing to set about them but turning them on.
  const subItems = NESTING_VIEWS.has(view.type) && (view.type === "timeline" || !!parentProperty(properties) || (!!onSubItems && !locked));
  const config = view.config;
  const set = (patch: ViewConfig) => onConfig({ ...config, ...patch });

  return (
    <>
      {view.type === "chart" ? (
        <ChartSettings view={view} properties={properties} onSet={set} />
      ) : view.type === "pivot" ? (
        <PivotSettings view={view} properties={properties} onSet={set} />
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
          <MenuSeparator />
          <LoadLimitChoices config={config} onSet={set} />
          <MenuSeparator />
          <WrapPropertiesToggle config={config} onSet={set} />
        </>
      ) : view.type === "board" ? (
        <>
          <LoadLimitChoices config={config} onSet={set} />
          <MenuSeparator />
          <WrapPropertiesToggle config={config} onSet={set} />
        </>
      ) : view.type === "map" ? (
        <MapSettings
          view={view}
          properties={properties}
          onSet={set}
          onCreatePlaceProperty={
            onCreatePlaceProperty && !locked
              ? () => {
                  close();
                  onCreatePlaceProperty();
                }
              : undefined
          }
        />
      ) : view.type === "agenda" ? (
        <AgendaSettings
          view={view}
          properties={properties}
          onSet={set}
          onCreateDateProperty={
            locked
              ? undefined
              : () => {
                  close();
                  onCreateDateProperty();
                }
          }
        />
      ) : view.type === "calendar" ? (
        // Saturdays and Sundays, in the month and the week alike.
        <Toggle on={config.showWeekends !== false} onChange={(on) => set({ showWeekends: on ? undefined : false })}>
          {t("showWeekends")}
        </Toggle>
      ) : view.type === "timeline" ? (
        <TimelineSettings
          view={view}
          properties={properties}
          locked={locked}
          onSet={set}
          onCreateDateProperty={() => {
            close();
            onCreateDateProperty();
          }}
        />
      ) : null}
      {subItems && (
        <SubItemsSettings
          view={view}
          properties={properties}
          separated={view.type === "timeline"}
          onSet={set}
          onSubItems={
            onSubItems && !locked
              ? (on, propertyId) => {
                  close();
                  onSubItems(on, propertyId);
                }
              : undefined
          }
        />
      )}
      {rows && (
        <>
          {/* After the view's own settings; a table, list or board may have none. */}
          {(view.type === "gallery" ||
            view.type === "board" ||
            view.type === "timeline" ||
            view.type === "map" ||
            view.type === "calendar" ||
            view.type === "agenda" ||
            subItems) && (
            <MenuSeparator />
          )}
          <Heading>{t("openRows")}</Heading>
          {OPEN_ROWS.map((where) => (
            <Choice key={where} active={openRowsOf(config) === where} onClick={() => set({ openRows: where === "panel" ? undefined : where })}>
              {t(`openRowsIn.${where}`)}
            </Choice>
          ))}
        </>
      )}
      {view.type === "timeline" && onDependencies && !locked && (
        <DependencySettings
          view={view}
          properties={properties}
          onDependencies={(on, input) => {
            // Turning them on or off closes the menu; changing a setting leaves it open.
            if (!on || !blockedByProperty(properties) || input?.propertyId) close();
            onDependencies(on, input);
          }}
        />
      )}
      {/* Rows archived on their own stay out of the view unless it shows them (server/page-outdated.ts). */}
      <MenuSeparator />
      {rows && (
        <Toggle on={config.showIcons !== false} onChange={(on) => set({ showIcons: on ? undefined : false })}>
          {t("showIcons")}
        </Toggle>
      )}
      {view.type === "table" && (
        <Toggle on={config.showVerticalLines !== false} onChange={(on) => set({ showVerticalLines: on ? undefined : false })}>
          {t("showVerticalLines")}
        </Toggle>
      )}
      {view.type === "table" && (
        <Toggle on={!!config.stripedRows} onChange={(on) => set({ stripedRows: on || undefined })}>
          {t("stripedRows")}
        </Toggle>
      )}
      <Toggle on={!!config.showOutdated} onChange={(on) => set({ showOutdated: on || undefined })}>
        {t("showOutdated")}
      </Toggle>
      {rows && (
        <MenuItem
          icon={<Palette className="h-3.5 w-3.5" />}
          trailing={config.colorRules?.length ? <span className="text-xs text-fg-muted">{config.colorRules.length}</span> : undefined}
          onClick={() => {
            close();
            onColorRules();
          }}
        >
          {t("colorRules")}
        </MenuItem>
      )}
      {/* A setting of the database, like sub-items: tasks planned in sprints of a database of their own. */}
      {rows && onSprints && !locked && (
        <MenuItem
          icon={<IterationCw className="h-3.5 w-3.5" />}
          title={tSprints("menuHint")}
          onClick={() => {
            close();
            onSprints();
          }}
        >
          {tSprints("menuItem")}
        </MenuItem>
      )}
    </>
  );
}

/**
 * Agenda views: the date that places rows on days, what marks them done, an optional priority
 * ordering rows within a time, and whether rows without a date are listed (see lib/agenda).
 */
function AgendaSettings({
  view,
  properties,
  onSet,
  onCreateDateProperty,
}: {
  view: View;
  properties: Property[];
  onSet: (patch: ViewConfig) => void;
  onCreateDateProperty?: () => void;
}) {
  const t = useTranslations("database.layout");
  const config = view.config;
  const dates = properties.filter((p) => p.type === "date");
  const statuses = properties.filter((p) => (AGENDA_STATUS_TYPES as readonly string[]).includes(p.type));
  const priorities = properties.filter((p) => (AGENDA_PRIORITY_TYPES as readonly string[]).includes(p.type));
  const date = agendaDateProperty(config, properties);
  const status = agendaStatusProperty(config, properties);
  const priority = agendaPriorityProperty(config, properties);
  // What marks rows done ranks nothing.
  const rankers = priorities.filter((p) => p.id !== status?.id || p.id === priority?.id);
  return (
    <>
      <Heading>{t("agendaDate")}</Heading>
      {!dates.length && <p className="px-2 pb-1.5 text-xs text-fg-faint">{t("agendaNeedsDate")}</p>}
      {dates.map((p) => (
        <Choice key={p.id} active={date?.id === p.id} onClick={() => onSet({ dateBy: p.id })}>
          {p.name}
        </Choice>
      ))}
      {onCreateDateProperty && (
        <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={onCreateDateProperty}>
          {t("newDateProperty")}
        </MenuItem>
      )}
      <MenuSeparator />
      <Heading>{t("agendaStatus")}</Heading>
      {!statuses.length && <p className="max-w-60 px-2 pb-1.5 text-xs text-fg-faint">{t("agendaNeedsStatus")}</p>}
      {statuses.map((p) => (
        <Choice key={p.id} active={status?.id === p.id} onClick={() => onSet({ statusBy: p.id })}>
          {p.name}
        </Choice>
      ))}
      <MenuSeparator />
      <Heading>{t("agendaPriority")}</Heading>
      <Choice active={!priority} onClick={() => onSet({ priorityBy: undefined })}>
        {t("noPriority")}
      </Choice>
      {rankers.map((p) => (
        <Choice key={p.id} active={priority?.id === p.id} onClick={() => onSet({ priorityBy: p.id })}>
          {p.name}
        </Choice>
      ))}
      <MenuSeparator />
      <Toggle on={showsUndated(config)} onChange={(on) => onSet({ showUndated: on ? undefined : false })}>
        {t("showUndated")}
      </Toggle>
    </>
  );
}

/** Map views: the place property that puts rows on the map, and what colors the pins. */
function MapSettings({
  view,
  properties,
  onSet,
  onCreatePlaceProperty,
}: {
  view: View;
  properties: Property[];
  onSet: (patch: ViewConfig) => void;
  onCreatePlaceProperty?: () => void;
}) {
  const t = useTranslations("database.layout");
  const places = properties.filter((p) => p.type === "place");
  const place = viewPlaceProperty(view.config, properties);
  const colors = properties.filter((p) => p.type === "select" || p.type === "status");
  const color = mapColorProperty(view, properties);
  return (
    <>
      <Heading>{t("place")}</Heading>
      {!places.length && <p className="px-2 pb-1.5 text-xs text-fg-faint">{t("needsPlace")}</p>}
      {places.map((p) => (
        <Choice key={p.id} active={place?.id === p.id} onClick={() => onSet({ placeBy: p.id })}>
          {p.name}
        </Choice>
      ))}
      {onCreatePlaceProperty && (
        <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={onCreatePlaceProperty}>
          {t("newPlaceProperty")}
        </MenuItem>
      )}
      {colors.length > 0 && (
        <>
          <MenuSeparator />
          <Heading>{t("pinColor")}</Heading>
          <Choice active={!color} onClick={() => onSet({ groupBy: undefined })}>
            {t("noPinColor")}
          </Choice>
          {colors.map((p) => (
            <Choice key={p.id} active={color?.id === p.id} onClick={() => onSet({ groupBy: p.id })}>
              {p.name}
            </Choice>
          ))}
        </>
      )}
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
            <MenuItem key={p.id} icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />} onClick={() => onSubItems?.(true, p.id)}>
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
            icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />}
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
  const groupable = properties.filter((p) => isGroupableProperty(p));
  const showTable = view.config.showTable !== false;
  return (
    <>
      <Heading>{t("start")}</Heading>
      {starts.map((p) => (
        <MenuItem
          key={p.id}
          active={p.id === start?.id}
          icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />}
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
        <MenuItem key={p.id} active={p.id === end?.id} icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />} onClick={() => onSet({ endDateBy: p.id })}>
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
        <MenuItem key={p.id} active={p.id === groupBy?.id} icon={<PropertyTypeIcon type={p.type} icon={p.options.icon} number={p.options.number} />} onClick={() => onSet({ groupBy: p.id })}>
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

const CHART_ICONS = { bar: ChartColumnBig, horizontal_bar: ChartBarBig, line: ChartLine, donut: ChartPie, number: Hash } as const;

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
  const groupable = properties.filter((p) => isGroupableProperty(p));
  const measurable = properties.filter((p) => chartAggregateFunctionsOf(p).length > 0);
  const accumulable = canAccumulate(chartType, groupBy, measure);
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  const stackable = canStack(chartType, measure) && !accumulate;
  const stackOptions = properties.filter((p) => isStackable(p.type) && p.id !== groupBy?.id);
  const stackBy = stackOptions.find((p) => p.id === config.stackBy);
  const hiddenGroups = config.hiddenGroups ?? [];
  const showsNoValue = !hiddenGroups.includes("");
  const groupType = groupBy && groupedType(groupBy);
  const dates = groupType && (groupType === "date" || holdsTimestamp(groupType));
  const bars = chartType === "bar" || chartType === "horizontal_bar";

  const setMeasure = (propertyId: string) => {
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) return onSet({ chartAggregate: undefined });
    const fns = chartAggregateFunctionsOf(prop);
    // Numbers are summed and checkboxes counted by default; other types count their values.
    const fn = fns.includes("sum") ? "sum" : fns[0];
    onSet({ chartAggregate: { fn, propertyId: prop.id } });
  };

  const typePicker = (
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
    </>
  );
  const measureSettings = (
    <SettingRow label={t("chart.measure")}>
      <NativeSelect
        label={t("chart.measure")}
        value={measure.kind === "count" ? "" : measure.prop.id}
        onChange={setMeasure}
        options={[{ value: "", label: t("chart.count") }, ...measurable.map((p) => ({ value: p.id, label: p.name }))]}
        className="w-36"
      />
    </SettingRow>
  );
  const calculationSettings = measure.kind === "aggregate" && (
    <SettingRow label={t("chart.calculation")}>
      <NativeSelect
        label={t("chart.calculation")}
        value={measure.fn}
        onChange={(fn) => onSet({ chartAggregate: { fn: fn as AggregateFn, propertyId: measure.prop.id } })}
        options={chartAggregateFunctions(measure.prop.type).map((fn) => ({ value: fn, label: t(`calculate.menu.${fn}`) }))}
        className="w-36"
      />
    </SettingRow>
  );

  // A number groups by nothing: what it measures is all there is to set.
  if (chartType === "number") {
    return (
      <>
        {typePicker}
        {measureSettings}
        {calculationSettings}
      </>
    );
  }

  return (
    <>
      {typePicker}
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
      {groupBy && <ValueGroupSettings prop={groupBy} settings={config} onChange={onSet} />}
      {measureSettings}
      {calculationSettings}
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

/**
 * Pivot views: what the rows and columns stand for (and how their dates and statuses group), what
 * each cell calculates, the order of rows and columns, and totals.
 */
function PivotSettings({ view, properties, onSet }: { view: View; properties: Property[]; onSet: (patch: ViewConfig) => void }) {
  const t = useTranslations("database");
  const config = view.config;
  const rowBy = pivotRowProperty(properties, config);
  const columnBy = pivotColumnProperty(properties, config, rowBy);
  const measure = pivotMeasure(config, properties);
  const groupable = properties.filter(isGroupableProperty);
  const measurable = properties.filter((p) => pivotAggregateFunctionsOf(p).length > 0);
  const datesOf = (p: Property | null) => !!p && (groupedType(p) === "date" || holdsTimestamp(groupedType(p)));

  const setMeasure = (propertyId: string) => {
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) return onSet({ chartAggregate: undefined });
    const fns = pivotAggregateFunctionsOf(prop);
    onSet({ chartAggregate: { fn: fns.includes("sum") ? "sum" : fns[0], propertyId: prop.id } });
  };
  const dateBy = (value: GroupDateBy, onChange: (by: GroupDateBy) => void) => (
    <SettingRow label={t("group.dateBy")}>
      <NativeSelect
        label={t("group.dateBy")}
        value={value}
        onChange={(v) => onChange(v as GroupDateBy)}
        options={GROUP_DATE_BY.map((by) => ({ value: by, label: t(`group.dateByOptions.${by}`) }))}
        className="w-36"
      />
    </SettingRow>
  );
  const statusBy = (value: ViewConfig["groupStatusBy"], onChange: (by: ViewConfig["groupStatusBy"]) => void) => (
    <SettingRow label={t("group.statusBy")}>
      <NativeSelect
        label={t("group.statusBy")}
        value={value === "group" ? "group" : "option"}
        onChange={(v) => onChange(v === "group" ? "group" : undefined)}
        options={[
          { value: "option", label: t("group.statusByOptions.option") },
          { value: "group", label: t("group.statusByOptions.group") },
        ]}
        className="w-36"
      />
    </SettingRow>
  );
  const sortBy = (label: string, value: ChartSort, onChange: (sort: ChartSort | undefined) => void) => (
    <SettingRow label={label}>
      <NativeSelect
        label={label}
        value={value}
        onChange={(v) => onChange(v === "group" ? undefined : (v as ChartSort))}
        options={CHART_SORTS.map((sort) => ({ value: sort, label: t(`chart.sorts.${sort}`) }))}
        className="w-36"
      />
    </SettingRow>
  );

  return (
    <>
      <Heading>{t("pivot.rows")}</Heading>
      <SettingRow label={t("pivot.property")}>
        <NativeSelect
          label={t("pivot.rowsBy")}
          value={rowBy?.id ?? ""}
          // Saved row order and hidden rows were group keys of the old property.
          onChange={(id) => onSet({ groupBy: id, hiddenGroups: undefined, groupOrder: undefined, ...(id === config.columnBy ? { columnBy: undefined } : {}) })}
          options={groupable.map((p) => ({ value: p.id, label: p.name }))}
          className="w-36"
        />
      </SettingRow>
      {datesOf(rowBy) && dateBy(groupDateByOf(config), (by) => onSet({ groupDateBy: by }))}
      {rowBy?.type === "status" && statusBy(config.groupStatusBy, (by) => onSet({ groupStatusBy: by }))}
      {rowBy && <ValueGroupSettings prop={rowBy} settings={config} onChange={onSet} />}
      {sortBy(t("pivot.sort"), chartSortOf(config), (sort) => onSet({ chartSort: sort }))}
      <MenuSeparator />
      <Heading>{t("pivot.columns")}</Heading>
      <SettingRow label={t("pivot.property")}>
        <NativeSelect
          label={t("pivot.columnsBy")}
          value={columnBy?.id ?? ""}
          onChange={(id) => onSet({ columnBy: id || undefined })}
          options={[{ value: "", label: t("pivot.noColumns") }, ...groupable.filter((p) => p.id !== rowBy?.id).map((p) => ({ value: p.id, label: p.name }))]}
          className="w-36"
        />
      </SettingRow>
      {datesOf(columnBy) && dateBy(groupDateByOf({ groupDateBy: config.columnDateBy }), (by) => onSet({ columnDateBy: by }))}
      {columnBy?.type === "status" && statusBy(config.columnStatusBy, (by) => onSet({ columnStatusBy: by }))}
      {columnBy && (
        <ValueGroupSettings
          prop={columnBy}
          settings={{ groupTextBy: config.columnTextBy, groupNumberBy: config.columnNumberBy }}
          onChange={(patch) =>
            onSet({
              ...("groupTextBy" in patch ? { columnTextBy: patch.groupTextBy } : {}),
              ...("groupNumberBy" in patch ? { columnNumberBy: patch.groupNumberBy } : {}),
            })
          }
        />
      )}
      {columnBy && sortBy(t("pivot.sort"), columnSortOf(config), (sort) => onSet({ columnSort: sort }))}
      <MenuSeparator />
      <Heading>{t("pivot.values")}</Heading>
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
            options={PIVOT_AGGREGATE_FNS.map((fn) => ({ value: fn, label: t(`calculate.menu.${fn}`) }))}
            className="w-36"
          />
        </SettingRow>
      )}
      <MenuSeparator />
      <Toggle on={config.showTotals !== false} onChange={(on) => onSet({ showTotals: on ? undefined : false })}>
        {t("pivot.showTotals")}
      </Toggle>
      <Toggle on={!!config.hideEmptyGroups} onChange={(on) => onSet({ hideEmptyGroups: on || undefined })}>
        {t("group.hideEmpty")}
      </Toggle>
    </>
  );
}

/**
 * How a view groups by text or a number besides the property: text by value or first letter,
 * numbers in ranges of a width (empty: worked out from the values; a percentage's in percent
 * points). Nothing for other types. `narrow` fits the group menu's smaller boxes.
 */
function ValueGroupSettings({
  prop,
  settings,
  onChange,
  narrow,
}: {
  prop: Property;
  settings: Pick<ValueSettings, "groupTextBy" | "groupNumberBy">;
  onChange: (patch: Pick<ViewConfig, "groupTextBy" | "groupNumberBy">) => void;
  narrow?: boolean;
}) {
  const t = useTranslations("database.group");
  const type = groupedType(prop);
  if (TEXT_GROUP_TYPES.has(type)) {
    return (
      <SettingRow label={t("textBy")}>
        <NativeSelect
          label={t("textBy")}
          value={groupTextByOf(settings)}
          onChange={(v) => onChange({ groupTextBy: v === "letter" ? "letter" : undefined })}
          options={GROUP_TEXT_BY.map((by) => ({ value: by, label: t(`textByOptions.${by}`) }))}
          className={narrow ? "w-28" : "w-36"}
        />
      </SettingRow>
    );
  }
  if (type !== "number") return null;
  const scale = isPercent(groupNumberFormat(prop)) ? 100 : 1;
  return (
    <SettingRow label={t("numberBy")}>
      <RangeWidth
        // A new property or a change from elsewhere starts the box over.
        key={`${prop.id}:${settings.groupNumberBy ?? ""}`}
        value={isNumberGroupSize(settings.groupNumberBy) ? settings.groupNumberBy * scale : null}
        onChange={(width) => onChange({ groupNumberBy: width === null ? undefined : width / scale })}
        className={narrow ? "w-24" : "w-36"}
      />
    </SettingRow>
  );
}

/** A number ranges' width, saved when the box is left or Enter is pressed; empty means automatic. */
function RangeWidth({ value, onChange, className }: { value: number | null; onChange: (width: number | null) => void; className: string }) {
  const t = useTranslations("database.group");
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const save = () => {
    const width = draft.trim() === "" ? null : Number(draft);
    if (width !== null && !isNumberGroupSize(width)) return setDraft(value === null ? "" : String(value));
    if (width !== value) onChange(width);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      aria-label={t("numberBy")}
      placeholder={t("numberByAuto")}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
      }}
      className={cn(
        "h-7 min-w-0 rounded-md border border-border bg-bg px-1.5 text-sm outline-none placeholder:text-fg-faint focus:border-accent",
        className,
      )}
    />
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
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
    >
      <span className="flex-1">{children}</span>
      <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-bg-active")}>
        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-bg shadow transition-[left,right]", on ? "inset-s-3.5" : "inset-s-0.5")} />
      </span>
    </button>
  );
}

/** Boards and galleries: long values on cards take more lines instead of being cut off. */
function WrapPropertiesToggle({ config, onSet }: { config: ViewConfig; onSet: (patch: ViewConfig) => void }) {
  const t = useTranslations("database.layout");
  return (
    <Toggle on={config.wrapProperties === true} onChange={(on) => onSet({ wrapProperties: on || undefined })}>
      {t("wrapProperties")}
    </Toggle>
  );
}

/** Boards (per column) and galleries: how many cards show before "Load more" (lib/load-limit). */
function LoadLimitChoices({ config, onSet }: { config: ViewConfig; onSet: (patch: ViewConfig) => void }) {
  const t = useTranslations("database.layout");
  const current = loadLimitOf(config);
  return (
    <>
      <Heading>{t("loadLimit")}</Heading>
      {LOAD_LIMITS.map((limit) => (
        <Choice key={limit} active={current === limit} onClick={() => onSet({ loadLimit: limit === DEFAULT_LOAD_LIMIT ? undefined : limit })}>
          {t("loadLimitCards", { count: limit })}
        </Choice>
      ))}
    </>
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
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
    >
      <span className={cn("flex-1", !wrap && "truncate")}>{children}</span>
      {active && <Check className="h-3.5 w-3.5 text-fg-muted" />}
    </button>
  );
}

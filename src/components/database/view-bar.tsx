"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  ListFilter,
  Pencil,
  Plus,
  Rows3,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, cn, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { useReorderDrag, type ReorderDragHandlers } from "@/components/use-reorder-drag";
import type {
  FilterCombinator,
  FilterEntry,
  FilterGroup,
  FilterOp,
  FilterRule,
  RelativeDateRange,
  SortRule,
  ViewConfig,
  ViewType,
} from "@/db/schema/app";
import {
  filterRules,
  isFilterGroup,
  isRelativeDateRange,
  MAX_RELATIVE_DAYS,
  RELATIVE_DATE_RANGES,
  rangeNeedsDays,
} from "@/lib/filters";
import { valueType } from "@/lib/derived";
import { GROUP_DATE_BY, groupDateByOf } from "@/lib/grouping";
import { pageLabel } from "@/lib/labels";
import {
  boardGroupProperty,
  filterNeedsValue,
  filterOperators,
  isGroupable,
  isHiddenInView,
  isSortable,
  moveProperty,
  toggleHiddenInView,
} from "@/lib/properties";
import { fromPercentPoints, isPercent } from "@/lib/number-format";
import { holdsOptions, holdsPeople, holdsTimestamp, PERSON_ME } from "@/lib/property-types";
import { VIEW_TYPES, viewDateProperty } from "@/lib/views";
import { DeletedSchemaList } from "./deleted-schema";
import { Floating, useFloating } from "./floating";
import { usePeople } from "./person-cell";
import { useFormatDate, useFormatNumber } from "./property-cell";
import { PropertyLock } from "./property-access";
import { PropertyTypeIcon, ViewIcon } from "./property-icons";
import { linkedRows, useRelations } from "./relation-context";
import { TITLE, type Property, type View } from "./types";

export { ViewIcon };

/** What a menu needs to list a database's deleted properties or views (see DeletedSchemaList). */
export type DeletedSchemaProps = { databaseId: string; reloadKey: unknown; onChanged: () => void };

export function ViewTabs({
  views,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
  readOnly,
  deleted,
}: {
  views: View[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: (type: ViewType) => void;
  onRename: (view: View, name: string) => void;
  onDelete: (view: View) => void;
  onMove: (id: string, target: string, side: "before" | "after") => void;
  readOnly?: boolean;
  /** Set for people who may change the database's schema: the menu lists its deleted views. */
  deleted?: DeletedSchemaProps;
}) {
  const t = useTranslations("database");
  const add = useFloating<HTMLButtonElement>();
  const [showDeleted, setShowDeleted] = useState(false);
  const closeAdd = () => {
    add.close();
    setShowDeleted(false);
  };
  const drag = useReorderDrag("x", onMove);
  const movable = !readOnly && views.length > 1;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
      {views.map((view) => (
        <ViewTab
          key={view.id}
          view={view}
          active={view.id === activeId}
          canDelete={views.length > 1}
          readOnly={readOnly}
          drag={movable ? drag.handlers(view.id) : undefined}
          onSelect={() => onSelect(view.id)}
          onRename={(name) => onRename(view, name)}
          onDelete={() => onDelete(view)}
        />
      ))}
      {!readOnly && (
        <>
          <button
            ref={add.ref}
            type="button"
            aria-label={t("viewTabs.addView")}
            title={t("viewTabs.addView")}
            onClick={add.toggle}
            className="mb-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <Plus className="h-4 w-4" />
          </button>
          <Floating open={add.open} anchor={add.el} onClose={closeAdd}>
            {showDeleted && deleted ? (
              <DeletedSchemaList kind="views" {...deleted} onBack={() => setShowDeleted(false)} />
            ) : (
              <>
                <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{t("viewTabs.addViewHeading")}</div>
                {VIEW_TYPES.map((type) => (
                  <MenuItem
                    key={type}
                    icon={<ViewIcon type={type} />}
                    onClick={() => {
                      closeAdd();
                      onAdd(type);
                    }}
                  >
                    {t(`views.${type}`)}
                  </MenuItem>
                ))}
                {deleted && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      trailing={<ChevronRight className="h-3.5 w-3.5" />}
                      onClick={() => setShowDeleted(true)}
                    >
                      {t("deleted.views")}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Floating>
        </>
      )}
    </div>
  );
}

function ViewTab({
  view,
  active,
  canDelete,
  readOnly,
  drag,
  onSelect,
  onRename,
  onDelete,
}: {
  view: View;
  active: boolean;
  canDelete: boolean;
  readOnly?: boolean;
  /** Set when the tab can be dragged to another place among the tabs. */
  drag?: ReorderDragHandlers;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("database.viewTabs");
  const menu = useFloating<HTMLButtonElement>();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(view.name);

  return (
    <div
      draggable={!!drag && !renaming}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      className={cn(
        "relative flex shrink-0 items-center border-b-2 pb-1",
        active ? "border-fg" : "border-transparent",
        drag?.dragging && "opacity-50",
      )}
    >
      {drag?.dropSide && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-0.5 bottom-1.5 w-0.5 bg-accent",
            drag.dropSide === "before" ? "-left-px" : "-right-px",
          )}
        />
      )}
      <button
        ref={menu.ref}
        type="button"
        onClick={() => (active && !readOnly ? menu.toggle() : onSelect())}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-bg-hover",
          active ? "font-medium text-fg" : "text-fg-muted",
        )}
      >
        <ViewIcon type={view.type} />
        <span className="max-w-40 truncate">{view.name}</span>
        {active && !readOnly && <ChevronDown className="h-3 w-3 text-fg-faint" />}
      </button>
      <Floating
        open={menu.open}
        anchor={menu.el}
        onClose={() => {
          menu.close();
          setRenaming(false);
        }}
      >
        {renaming ? (
          <div className="w-56 p-1">
            <Input
              autoFocus
              value={name}
              aria-label={t("viewName")}
              className="h-7"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (name.trim()) onRename(name.trim());
                  setRenaming(false);
                  menu.close();
                }
              }}
            />
          </div>
        ) : (
          <>
            <MenuItem
              icon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => {
                setName(view.name);
                setRenaming(true);
              }}
            >
              {t("rename")}
            </MenuItem>
            {canDelete && (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => {
                    menu.close();
                    onDelete();
                  }}
                >
                  {t("deleteView")}
                </MenuItem>
              </>
            )}
          </>
        )}
      </Floating>
    </div>
  );
}

type Column = { id: string; name: string; type: Property["type"] | "title"; prop: Property | null };

/** Columns filters and sorts offer; a formula is offered as a property of its result type. */
/**
 * A menu label inside a sentence ("Status is empty"): only its first letter lower-cased, since
 * German capitalises nouns anywhere ("diese Woche", not "diese woche").
 */
function lowerFirst(label: string, locale: string) {
  return label.charAt(0).toLocaleLowerCase(locale) + label.slice(1);
}

function columnsOf(properties: Property[], titleName: string): Column[] {
  return [
    { id: TITLE, name: titleName, type: "title", prop: null },
    ...properties.map((p) => ({ id: p.id, name: p.name, type: valueType(p), prop: p })),
  ];
}

function ToolbarButton({
  icon,
  label,
  count,
  active,
  buttonRef,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm hover:bg-bg-hover",
        active ? "text-accent" : "text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {count ? <span className="text-xs tabular-nums">{count}</span> : null}
    </button>
  );
}

/**
 * The search box of a database view (see lib/row-search): a button that opens into a field. What's
 * typed narrows the rows on screen for this person only and isn't saved with the view. Escape
 * clears it; leaving it empty closes it again.
 */
export function ViewSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations("database.toolbar");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open && !value) {
    return <ToolbarButton icon={<Search className="h-4 w-4" />} label={t("search")} onClick={() => setOpen(true)} />;
  }
  const close = () => {
    onChange("");
    setOpen(false);
  };
  return (
    // On phones the open field covers the toolbar's row instead of pushing it off the screen.
    <div className="relative flex w-48 items-center max-md:absolute max-md:inset-0 max-md:z-10 max-md:w-auto max-md:bg-bg">
      <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fg-muted" />
      <input
        ref={input}
        type="search"
        value={value}
        placeholder={t("searchPlaceholder")}
        aria-label={t("search")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
        className="h-7 w-full rounded-md border border-border bg-bg px-7 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label={t("clearSearch")}
          title={t("clearSearch")}
          // Keeps the field focused, so the clear doesn't close it on the way.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * A request to open the filters (from a column's menu): `id` tells requests apart, `filters` is how
 * many top-level filters the view `viewId` has once the new one is saved.
 */
export type FilterRequest = { id: number; viewId: string; filters: number };

/** Filter, sort, group and property visibility controls for the active view. */
export function ViewToolbar({
  view,
  properties,
  onConfig,
  filterRequest,
  onCreateGroupProperty,
  onCreateDateProperty,
  readOnly,
  locked,
  deleted,
}: {
  view: View;
  properties: Property[];
  onConfig: (config: ViewConfig) => void;
  /** Opens the filters once the view has the filter a column's menu added. */
  filterRequest?: FilterRequest | null;
  onCreateGroupProperty: () => void;
  onCreateDateProperty: () => void;
  readOnly?: boolean;
  /** The schema is locked: no creating properties from the group and calendar menus. */
  locked?: boolean;
  /** Set for people who may change the database's schema: the Properties menu lists deleted ones. */
  deleted?: DeletedSchemaProps;
}) {
  const t = useTranslations("database");
  const filterMenu = useFloating<HTMLButtonElement>();
  const sortMenu = useFloating<HTMLButtonElement>();
  const groupMenu = useFloating<HTMLButtonElement>();
  const propsMenu = useFloating<HTMLButtonElement>();
  const [showDeleted, setShowDeleted] = useState(false);
  const closeProps = () => {
    propsMenu.close();
    setShowDeleted(false);
  };
  const config = view.config;
  const filters = config.filters ?? [];
  const filterCount = filterRules(filters).length;
  // The filter editor starts from the view's filters when it opens, so it waits for the new one.
  const [handledRequest, setHandledRequest] = useState(0);
  const requested =
    !!filterRequest &&
    filterRequest.viewId === view.id &&
    filterRequest.id > handledRequest &&
    filters.length >= filterRequest.filters;
  const filtersOpen = filterMenu.open || requested;
  const closeFilters = () => {
    filterMenu.close();
    if (filterRequest) setHandledRequest(filterRequest.id);
  };
  const sorts = config.sorts ?? [];
  const hiddenCount = properties.filter((p) => isHiddenInView(view, p)).length;
  const columns = columnsOf(properties, t("nameColumn"));
  const groupProps = properties.filter((p) => isGroupable(p.type));
  // Boards always group (by the first fitting property until one is picked); tables only on request.
  const groupBy =
    view.type === "board"
      ? boardGroupProperty(properties, config.groupBy)
      : groupProps.find((p) => p.id === config.groupBy);
  const dateMenu = useFloating<HTMLButtonElement>();
  const dateProps = properties.filter((p) => p.type === "date");
  const dateBy = viewDateProperty(config, properties);
  // `properties` is in the view's order, so dragging one in the properties menu reorders the view.
  const propertyDrag = useReorderDrag("y", (moved, target, side) =>
    onConfig({ ...config, propertyOrder: moveProperty(properties, moved, target, side) }),
  );

  if (readOnly) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ToolbarButton
        icon={<ListFilter className="h-4 w-4" />}
        label={t("toolbar.filter")}
        count={filterCount}
        active={filterCount > 0}
        buttonRef={filterMenu.ref}
        onClick={() => (filtersOpen ? closeFilters() : filterMenu.setOpen(true))}
      />
      <Floating open={filtersOpen} anchor={filterMenu.el} onClose={closeFilters} align="end">
        <FilterEditor
          columns={columns}
          filters={filters}
          combinator={config.filterCombinator ?? "and"}
          onChange={(f, combinator) =>
            onConfig({ ...config, filters: f, filterCombinator: combinator === "or" ? "or" : undefined })
          }
        />
      </Floating>

      <ToolbarButton
        icon={<ArrowUpDown className="h-4 w-4" />}
        label={t("toolbar.sort")}
        count={sorts.length}
        active={sorts.length > 0}
        buttonRef={sortMenu.ref}
        onClick={sortMenu.toggle}
      />
      <Floating open={sortMenu.open} anchor={sortMenu.el} onClose={sortMenu.close} align="end">
        <SortEditor
          columns={columns.filter((c) => isSortable(c.type))}
          sorts={sorts}
          onChange={(s) => onConfig({ ...config, sorts: s })}
        />
      </Floating>

      {(view.type === "board" || view.type === "table") && (
        <>
          <ToolbarButton
            icon={<Rows3 className="h-4 w-4" />}
            label={groupBy ? t("toolbar.groupWithName", { name: groupBy.name }) : t("toolbar.group")}
            active={view.type === "table" && Boolean(groupBy)}
            buttonRef={groupMenu.ref}
            onClick={groupMenu.toggle}
          />
          <Floating open={groupMenu.open} anchor={groupMenu.el} onClose={groupMenu.close} align="end">
            <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{t("toolbar.groupBy")}</div>
            {view.type === "table" && (
              <MenuItem
                active={!groupBy}
                icon={<X className="h-3.5 w-3.5" />}
                onClick={() => {
                  groupMenu.close();
                  if (groupBy) onConfig({ ...config, groupBy: undefined });
                }}
              >
                {t("toolbar.noGrouping")}
              </MenuItem>
            )}
            {groupProps.map((p) => (
              <MenuItem
                key={p.id}
                active={p.id === groupBy?.id}
                icon={<PropertyTypeIcon type={p.type} />}
                onClick={() => {
                  groupMenu.close();
                  onConfig({ ...config, groupBy: p.id });
                }}
              >
                {p.name}
              </MenuItem>
            ))}
            {!groupProps.length && (
              <div className="max-w-60 px-2 pb-1 text-xs text-fg-faint">{t("toolbar.groupNeedsSelect")}</div>
            )}
            {groupBy && <GroupSettings prop={groupBy} config={config} onConfig={onConfig} />}
            {!locked && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => {
                    groupMenu.close();
                    onCreateGroupProperty();
                  }}
                >
                  {t("toolbar.newSelectProperty")}
                </MenuItem>
              </>
            )}
          </Floating>
        </>
      )}

      {view.type === "calendar" && (
        <>
          <ToolbarButton
            icon={<CalendarDays className="h-4 w-4" />}
            label={dateBy ? t("toolbar.calendarWithName", { name: dateBy.name }) : t("toolbar.calendarBy")}
            buttonRef={dateMenu.ref}
            onClick={dateMenu.toggle}
          />
          <Floating open={dateMenu.open} anchor={dateMenu.el} onClose={dateMenu.close} align="end">
            <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{t("toolbar.calendarBy")}</div>
            {dateProps.map((p) => (
              <MenuItem
                key={p.id}
                active={p.id === dateBy?.id}
                icon={<PropertyTypeIcon type={p.type} />}
                onClick={() => {
                  dateMenu.close();
                  onConfig({ ...config, dateBy: p.id });
                }}
              >
                {p.name}
              </MenuItem>
            ))}
            {!dateProps.length && (
              <div className="px-2 pb-1 text-xs text-fg-faint">{t("toolbar.calendarNeedsDate")}</div>
            )}
            {!locked && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => {
                    dateMenu.close();
                    onCreateDateProperty();
                  }}
                >
                  {t("toolbar.newDateProperty")}
                </MenuItem>
              </>
            )}
          </Floating>
        </>
      )}

      <ToolbarButton
        icon={<EyeOff className="h-4 w-4" />}
        label={t("toolbar.properties")}
        count={hiddenCount || undefined}
        buttonRef={propsMenu.ref}
        onClick={propsMenu.toggle}
      />
      <Floating open={propsMenu.open} anchor={propsMenu.el} onClose={closeProps} align="end">
        {showDeleted && deleted ? (
          <DeletedSchemaList kind="properties" {...deleted} onBack={() => setShowDeleted(false)} />
        ) : (
          <div className="w-60">
            <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{t("toolbar.shownInView")}</div>
            {!properties.length && <div className="px-2 pb-1.5 text-xs text-fg-faint">{t("toolbar.noProperties")}</div>}
            {properties.map((p) => {
              const isHidden = isHiddenInView(view, p);
              const drag = propertyDrag.handlers(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  data-property={p.id}
                  draggable
                  onDragStart={drag.onDragStart}
                  onDragOver={drag.onDragOver}
                  onDrop={drag.onDrop}
                  onDragEnd={drag.onDragEnd}
                  onClick={() => onConfig(toggleHiddenInView(view, p))}
                  className={cn(
                    "group/prop relative flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover",
                    drag.dragging && "opacity-50",
                  )}
                >
                  {drag.dropSide && (
                    <span
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute inset-x-1 h-0.5 bg-accent",
                        drag.dropSide === "before" ? "-top-px" : "-bottom-px",
                      )}
                    />
                  )}
                  <GripVertical
                    aria-hidden
                    className="-ml-1.5 h-3.5 w-3.5 shrink-0 cursor-grab text-fg-faint opacity-0 group-hover/prop:opacity-100"
                  />
                  <PropertyTypeIcon type={p.type} className="-ml-1 h-3.5 w-3.5 text-fg-muted" />
                  <span className={cn("flex-1 truncate", isHidden && "text-fg-faint")}>{p.name}</span>
                  <PropertyLock propertyId={p.id} />
                  {isHidden ? (
                    <EyeOff className="h-3.5 w-3.5 text-fg-faint" aria-label={t("toolbar.hidden")} />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-fg-muted" aria-label={t("toolbar.shown")} />
                  )}
                </button>
              );
            })}
            {deleted && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  trailing={<ChevronRight className="h-3.5 w-3.5" />}
                  onClick={() => setShowDeleted(true)}
                >
                  {t("deleted.properties")}
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Floating>
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
  const dates = prop.type === "date" || holdsTimestamp(prop.type);
  return (
    <>
      <MenuSeparator />
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

/** Summary line under the tabs when the view filters or sorts, with a quick clear. */
export function ActiveRulesBar({
  view,
  properties,
  onConfig,
  readOnly,
}: {
  view: View;
  properties: Property[];
  onConfig: (config: ViewConfig) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations("database");
  const locale = useLocale();
  const describeFilter = useDescribeFilter();
  const filters = view.config.filters ?? [];
  const sorts = view.config.sorts ?? [];
  if (!filters.length && !sorts.length) return null;
  const columns = columnsOf(properties, t("nameColumn"));
  const nameOf = (id: string) => columns.find((c) => c.id === id)?.name ?? t("activeRules.unknownProperty");
  const word = (combinator: FilterCombinator) => lowerFirst(t(`filter.${combinator}`), locale);
  // A group reads as one chip: "(Status is Done or Assignee contains Me)".
  const describeEntry = (entry: FilterEntry): string =>
    isFilterGroup(entry)
      ? `(${entry.rules.map(describeEntry).join(` ${word(entry.combinator)} `)})`
      : describeFilter(entry, columns);
  const or = view.config.filterCombinator === "or";
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1.5 text-xs">
      {sorts.map((s) => (
        <span
          key={`s-${s.propertyId}`}
          title={t(s.direction === "asc" ? "activeRules.sortedAscending" : "activeRules.sortedDescending", {
            property: nameOf(s.propertyId),
          })}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-fg-muted"
        >
          {s.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {nameOf(s.propertyId)}
        </span>
      ))}
      {/* Chips side by side read as "and"; an "or" between them is spelled out. */}
      {filters.map((f, i) => (
        <Fragment key={`f-${i}`}>
          {or && i > 0 && <span className="text-fg-faint">{word("or")}</span>}
          <span className="inline-flex min-h-6 items-center gap-1 rounded-md border border-border px-1.5 text-fg-muted">
            <ListFilter className="h-3 w-3 shrink-0" />
            {describeEntry(f)}
          </span>
        </Fragment>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={() => onConfig({ ...view.config, filters: [], filterCombinator: undefined, sorts: [] })}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-3 w-3" />
          {t("activeRules.clear")}
        </button>
      )}
    </div>
  );
}

/** Translated operator label for a filter rule (falls back to the raw op). */
function useOperatorLabel() {
  const t = useTranslations("database.filter.ops");
  return (type: Column["type"], op: FilterOp) => {
    const label = filterOperators(type).find((o) => o.op === op)?.label;
    return label ? t(label) : op;
  };
}

/** One-line summary of a filter rule, e.g. "Status is Done", in the UI language. */
function useDescribeFilter() {
  const t = useTranslations("database.activeRules");
  const locale = useLocale();
  const formatDate = useFormatDate();
  const formatNumber = useFormatNumber();
  const operatorLabel = useOperatorLabel();
  const relations = useRelations();
  const { people } = usePeople();
  const tc = useTranslations("common");
  const tf = useTranslations("database.filter");
  const tp = useTranslations("database.person");
  const rangeLabel = useRangeLabel();
  return (f: FilterRule, columns: Column[]) => {
    const col = columns.find((c) => c.id === f.propertyId);
    if (!col) return t("unknownFilter");
    if (f.op === "is_within") {
      const range = isRelativeDateRange(f.value) ? lowerFirst(rangeLabel(f.value, f.days), locale) : "…";
      return t("filterWithin", { property: col.name, range });
    }
    const operator = lowerFirst(operatorLabel(col.type, f.op), locale);
    if (!filterNeedsValue(f.op) || col.type === "checkbox") {
      return t("filterWithoutValue", { property: col.name, operator });
    }
    let value = String(f.value ?? "");
    if (col.prop && holdsOptions(col.type)) {
      value = col.prop.options.options?.find((o) => o.id === f.value)?.name ?? "…";
    } else if (col.prop && col.type === "relation") {
      const row = linkedRows(relations?.targets[col.prop.id], [f.value])[0];
      value = row ? pageLabel(row.title, tc("untitled")) : "…";
    } else if (holdsPeople(col.type)) {
      value = f.value === PERSON_ME ? tf("me") : (people.find((p) => p.id === f.value)?.name || tp("unknown"));
    } else if (col.type === "number" && typeof f.value === "number") {
      // Percentages filter in percent points (see lib/properties); amounts show with their currency.
      const unit = col.prop?.type === "number" ? col.prop.options.number : undefined;
      value = formatNumber(isPercent(unit) ? fromPercentPoints(f.value) : f.value, unit);
    } else if ((col.type === "date" || holdsTimestamp(col.type)) && value) {
      value = formatDate(value);
    }
    return t("filterWithValue", { property: col.name, operator, value: value || "…" });
  };
}

/** Message keys (`database.filter.relative.*`) for the choices of an "is within" rule. */
const RANGE_LABELS: Record<RelativeDateRange, "today" | "thisWeek" | "thisMonth" | "pastNDays" | "nextNDays"> = {
  today: "today",
  this_week: "thisWeek",
  this_month: "thisMonth",
  past_n_days: "pastNDays",
  next_n_days: "nextNDays",
};

/** "This week", "Past 7 days"… for an "is within" rule's value. */
function useRangeLabel() {
  const t = useTranslations("database.filter.relative");
  return (range: RelativeDateRange, days?: number) => {
    if (range === "past_n_days" && days) return t("pastDays", { count: days });
    if (range === "next_n_days" && days) return t("nextDays", { count: days });
    return t(RANGE_LABELS[range]);
  };
}

/** Groups the editor lets users add: top-level groups of rules. Deeper groups (made over MCP) still show and edit. */
const EDITOR_GROUP_DEPTH = 1;

function FilterEditor({
  columns,
  filters,
  combinator,
  onChange,
}: {
  columns: Column[];
  filters: FilterEntry[];
  combinator: FilterCombinator;
  onChange: (filters: FilterEntry[], combinator: FilterCombinator) => void;
}) {
  const t = useTranslations("database.filter");
  // The top level edits like a group. Text values are drafted locally and saved with a short debounce.
  const [draft, setDraft] = useState<FilterGroup>({ type: "group", combinator, rules: filters });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const save = (root: FilterGroup) => onChangeRef.current(root.rules, root.combinator);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        save(latest.current);
      }
    },
    [],
  );

  const update = (next: FilterGroup, debounce = false) => {
    setDraft(next);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (debounce) {
      timer.current = setTimeout(() => {
        timer.current = null;
        save(next);
      }, 400);
    } else save(next);
  };

  return (
    <div className="w-[34rem] max-w-[calc(100vw-2rem)] p-1">
      {!draft.rules.length && <div className="px-2 py-1.5 text-xs text-fg-faint">{t("empty")}</div>}
      <FilterEntries group={draft} depth={0} columns={columns} onChange={update} />
      <MenuSeparator />
      <div className="flex flex-wrap items-center justify-between gap-1">
        <div className="flex flex-wrap items-center">
          <MenuItemInline
            onClick={() => update({ ...draft, rules: [...draft.rules, defaultRule(columns[0])] })}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            {t("add")}
          </MenuItemInline>
          <MenuItemInline
            onClick={() => update({ ...draft, rules: [...draft.rules, newGroup(columns[0])] })}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            {t("addGroup")}
          </MenuItemInline>
        </div>
        {draft.rules.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => update({ type: "group", combinator: "and", rules: [] })}>
            {t("clearAll")}
          </Button>
        )}
      </div>
    </div>
  );
}

function defaultRule(col: Column): FilterRule {
  return { propertyId: col.id, op: filterOperators(col.type)[0].op };
}

function newGroup(col: Column): FilterGroup {
  return { type: "group", combinator: "and", rules: [defaultRule(col)] };
}

/**
 * The rules and groups of one group: the first line reads "Where", the second holds
 * the and/or switch, and later lines repeat its choice (a group combines all its rules one way).
 */
function FilterEntries({
  group,
  depth,
  columns,
  onChange,
}: {
  group: FilterGroup;
  depth: number;
  columns: Column[];
  onChange: (group: FilterGroup, debounce?: boolean) => void;
}) {
  const t = useTranslations("database.filter");
  // A group whose last rule is removed goes away with it.
  const setEntry = (i: number, entry: FilterEntry | null, debounce = false) => {
    const rules = group.rules.flatMap((e, j) => (j !== i ? [e] : entry && !(isFilterGroup(entry) && !entry.rules.length) ? [entry] : []));
    onChange({ ...group, rules }, debounce);
  };
  return group.rules.map((entry, i) => (
    <div key={i} className="flex items-start gap-1 px-1 py-1">
      <div className="flex h-7 w-16 shrink-0 items-center text-sm text-fg-muted">
        {i === 0 ? (
          <span className="px-1.5">{t("where")}</span>
        ) : i === 1 ? (
          <NativeSelect
            label={t("combinator")}
            value={group.combinator}
            onChange={(c) => onChange({ ...group, combinator: c === "or" ? "or" : "and" })}
            options={[
              { value: "and", label: t("and") },
              { value: "or", label: t("or") },
            ]}
            className="w-full"
          />
        ) : (
          <span className="px-1.5">{t(group.combinator)}</span>
        )}
      </div>
      {isFilterGroup(entry) ? (
        <>
          <div className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle p-0.5">
            <FilterEntries
              group={entry}
              depth={depth + 1}
              columns={columns}
              onChange={(next, debounce) => setEntry(i, next, debounce)}
            />
            <div className="flex flex-wrap items-center">
              <MenuItemInline
                onClick={() => setEntry(i, { ...entry, rules: [...entry.rules, defaultRule(columns[0])] })}
                icon={<Plus className="h-3.5 w-3.5" />}
              >
                {t("add")}
              </MenuItemInline>
              {depth + 1 < EDITOR_GROUP_DEPTH && (
                <MenuItemInline
                  onClick={() => setEntry(i, { ...entry, rules: [...entry.rules, newGroup(columns[0])] })}
                  icon={<Plus className="h-3.5 w-3.5" />}
                >
                  {t("addGroup")}
                </MenuItemInline>
              )}
            </div>
          </div>
          <RemoveButton label={t("removeGroup")} onClick={() => setEntry(i, null)} />
        </>
      ) : (
        <FilterRuleRow
          rule={entry}
          columns={columns}
          onChange={(next, debounce) => setEntry(i, next, debounce)}
          onRemove={() => setEntry(i, null)}
        />
      )}
    </div>
  ));
}

/** Property, condition and value of one rule; the value drops below on narrow screens. */
function FilterRuleRow({
  rule,
  columns,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  columns: Column[];
  onChange: (rule: FilterRule, debounce?: boolean) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("database.filter");
  const operatorLabel = useOperatorLabel();
  const col = columns.find((c) => c.id === rule.propertyId) ?? columns[0];
  const ops = filterOperators(col.type);
  const set = (patch: Partial<FilterRule>, debounce = false) => onChange({ ...rule, ...patch }, debounce);
  // "Is within" takes a range instead of a value, so switching to or from it starts the value over.
  const setOp = (op: FilterOp) => {
    if ((op === "is_within") === (rule.op === "is_within")) return set({ op });
    onChange({ propertyId: rule.propertyId, op });
  };
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <NativeSelect
          label={t("property")}
          value={col.id}
          onChange={(id) => {
            const next = columns.find((c) => c.id === id);
            if (next) onChange(defaultRule(next));
          }}
          options={columns.map((c) => ({ value: c.id, label: c.name }))}
          className="min-w-0 flex-1 basis-28"
        />
        <NativeSelect
          label={t("condition")}
          value={rule.op}
          onChange={(op) => setOp(op as FilterOp)}
          options={ops.map((o) => ({ value: o.op, label: operatorLabel(col.type, o.op) }))}
          className="min-w-0 flex-1 basis-28"
        />
        {rule.op === "is_within" ? (
          <div className="min-w-0 flex-1 basis-40">
            <RelativeDateValue rule={rule} onChange={set} />
          </div>
        ) : (
          filterNeedsValue(rule.op) &&
          col.type !== "checkbox" && (
            <div className="min-w-0 flex-1 basis-32">
              <FilterValue col={col} value={rule.value} onChange={(value, debounce) => set({ value }, debounce)} />
            </div>
          )
        )}
      </div>
      <RemoveButton label={t("remove")} onClick={onRemove} />
    </>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/** Today, this week, this month, or past / next N days (with N). */
function RelativeDateValue({
  rule,
  onChange,
}: {
  rule: FilterRule;
  onChange: (patch: Partial<FilterRule>, debounce?: boolean) => void;
}) {
  const t = useTranslations("database.filter");
  const rangeLabel = useRangeLabel();
  const range = isRelativeDateRange(rule.value) ? rule.value : null;
  return (
    <div className="flex items-center gap-1">
      <NativeSelect
        label={t("range")}
        value={range ?? ""}
        onChange={(v) => {
          const next = isRelativeDateRange(v) ? v : undefined;
          onChange({ value: next, days: next && rangeNeedsDays(next) ? (rule.days ?? 7) : undefined });
        }}
        options={[
          { value: "", label: t("choose") },
          ...RELATIVE_DATE_RANGES.map((r) => ({ value: r, label: rangeLabel(r) })),
        ]}
        className="min-w-0 flex-1"
      />
      {range && rangeNeedsDays(range) && (
        // Input's own `w-full` wins over a width passed in, so the wrapper sets the width.
        <div className="w-16 shrink-0">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RELATIVE_DAYS}
            step={1}
            aria-label={t("days")}
            title={t("days")}
            value={rule.days ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              const n = Math.round(Number(raw));
              // Out-of-range counts are clamped rather than saved; an empty box leaves the rule incomplete.
              const days = raw === "" || !Number.isFinite(n) ? undefined : Math.min(MAX_RELATIVE_DAYS, Math.max(1, n));
              onChange({ days }, true);
            }}
            className="h-7"
          />
        </div>
      )}
    </div>
  );
}

function FilterValue({
  col,
  value,
  onChange,
}: {
  col: Column;
  value: unknown;
  onChange: (value: unknown, debounce?: boolean) => void;
}) {
  const t = useTranslations("database.filter");
  const tc = useTranslations("common");
  const relations = useRelations();
  const { people, viewerId } = usePeople();
  const tp = useTranslations("database.person");
  if (holdsPeople(col.type)) {
    // Former members stay listed only while a filter still points at them.
    const listed = people.filter((p) => p.active || p.id === value);
    return (
      <NativeSelect
        label={t("value")}
        value={typeof value === "string" ? value : ""}
        onChange={(v) => onChange(v || undefined)}
        options={[
          { value: "", label: t("choose") },
          { value: PERSON_ME, label: t("me") },
          ...listed.map((p) => ({
            value: p.id,
            label: p.id === viewerId ? tp("you", { name: p.name }) : p.name || tp("unknown"),
          })),
        ]}
        className="w-full"
      />
    );
  }
  if (col.type === "relation" && col.prop) {
    const rows = relations?.targets[col.prop.id]?.rows ?? [];
    return (
      <NativeSelect
        label={t("value")}
        value={typeof value === "string" ? value : ""}
        onChange={(v) => onChange(v || undefined)}
        options={[{ value: "", label: t("choose") }, ...rows.map((r) => ({ value: r.id, label: pageLabel(r.title, tc("untitled")) }))]}
        className="w-full"
      />
    );
  }
  if (holdsOptions(col.type) && col.prop) {
    const options = col.prop.options.options ?? [];
    return (
      <NativeSelect
        label={t("value")}
        value={typeof value === "string" ? value : ""}
        onChange={(v) => onChange(v || undefined)}
        options={[{ value: "", label: t("choose") }, ...options.map((o) => ({ value: o.id, label: o.name }))]}
        className="w-full"
      />
    );
  }
  // Created and last edited times are filtered by day, like dates.
  if (col.type === "date" || holdsTimestamp(col.type)) {
    return (
      <Input
        type="date"
        aria-label={t("value")}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-7"
      />
    );
  }
  return (
    <Input
      aria-label={t("value")}
      type={col.type === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={t("value")}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(col.type === "number" ? (raw === "" ? undefined : Number(raw)) : raw, true);
      }}
      className="h-7"
    />
  );
}

function SortEditor({
  columns,
  sorts,
  onChange,
}: {
  columns: Column[];
  sorts: SortRule[];
  onChange: (sorts: SortRule[]) => void;
}) {
  const t = useTranslations("database.sort");
  const unused = columns.filter((c) => !sorts.some((s) => s.propertyId === c.id));
  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] p-1">
      {!sorts.length && <div className="px-2 py-1.5 text-xs text-fg-faint">{t("empty")}</div>}
      {sorts.map((rule, i) => (
        <div key={rule.propertyId} className="flex items-center gap-1 px-1 py-1">
          <NativeSelect
            label={t("property")}
            value={rule.propertyId}
            onChange={(id) => onChange(sorts.map((s, j) => (j === i ? { ...s, propertyId: id } : s)))}
            options={columns
              .filter((c) => c.id === rule.propertyId || !sorts.some((s) => s.propertyId === c.id))
              .map((c) => ({ value: c.id, label: c.name }))}
            className="flex-1"
          />
          <NativeSelect
            label={t("direction")}
            value={rule.direction}
            onChange={(d) => onChange(sorts.map((s, j) => (j === i ? { ...s, direction: d as "asc" | "desc" } : s)))}
            options={[
              { value: "asc", label: t("ascending") },
              { value: "desc", label: t("descending") },
            ]}
            className="w-32"
          />
          <button
            type="button"
            aria-label={t("remove")}
            onClick={() => onChange(sorts.filter((_, j) => j !== i))}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <MenuSeparator />
      <div className="flex items-center justify-between">
        {unused.length > 0 ? (
          <MenuItemInline
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => onChange([...sorts, { propertyId: unused[0].id, direction: "asc" }])}
          >
            {t("add")}
          </MenuItemInline>
        ) : (
          <span />
        )}
        {sorts.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            {t("clearAll")}
          </Button>
        )}
      </div>
    </div>
  );
}

function MenuItemInline({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      {icon}
      {children}
    </button>
  );
}

export function NativeSelect({
  label,
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-7 min-w-0 rounded-md border border-border bg-bg px-1.5 text-sm outline-none focus:border-accent disabled:opacity-50",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

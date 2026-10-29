"use client";

import { useToggleAllShortcut } from "@/components/toggle-all";
import { FlagTriangleRight, Plus, TriangleAlert, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@/components/ui";
import { useStuckMark } from "@/components/use-stuck-mark";
import { useDocumentViewName } from "@/components/page/document-title";
import { markNewPage } from "@/components/page/new-page-focus";
import type { ViewConfig, ViewType } from "@/db/schema/app";
import type { LinkedView } from "@/lib/embed-blocks";
import { colorRows, type RowColors } from "@/lib/color-rules";
import { valueType } from "@/lib/derived";
import { applyView, defaultsFromFilters, filterOperators, isHiddenInView, orderProperties } from "@/lib/properties";
import { atLeast } from "@/lib/property-access";
import { searchRows } from "@/lib/row-search";
import { opensNewTab } from "@/lib/row-panel";
import { galleryCover, openRowsOf, opensRows, withViewSorts } from "@/lib/views";
import { holdsSprints, sprintProperty } from "@/lib/sprints";
import { getSprintsAction } from "@/app/actions/databases";
import { AutomationsButton, ButtonAutomationsProvider } from "./automations-button";
import { JiraSyncButton } from "./jira-sync-button";
import { GalleryView } from "./gallery-view";
import { ListView } from "./list-view";
import { openInNewTab, RowOpenerContext, useRowPanel, type RowOpener } from "./row-panel-context";
import { RowTemplatesMenu } from "./row-templates-menu";
import { PeopleProvider, type PeopleContextValue } from "./person-cell";
import { RelationProvider, type RelationContextValue } from "./relation-context";
import { PropertyAccessProvider, type PropertyAccessContextValue } from "./property-access";
import { SchemaProvider } from "./schema-context";
import { TableView } from "./table-view";
import type { DatabaseSnapshot, View } from "./types";
import { useViewerTimeZone } from "./use-today";
import { useDatabase } from "./use-database";
import { OfflineNotice } from "@/components/offline/offline-notice";
import { AiAutofillProvider, type AiAutofillContextValue } from "./ai-autofill";
import { useIsOffline } from "@/components/offline/offline-context";
import { ActiveRulesBar, ViewSearch, ViewTabs, ViewToolbar, type FilterRequest, type ViewExportFormat } from "./view-bar";
import { saveDownload } from "./download";
import { timelineDates, ViewLayoutMenu } from "./view-settings";
import { lazyPart } from "@/components/lazy-part";

/** The rules a viewer who may not change a view sets for themselves, or a draft of its rules (see `ownRules`). */
type PersonalRules = Pick<ViewConfig, "filters" | "filterCombinator" | "sorts">;

/** Whether two sets of filters and sorts are the same, a missing list being an empty one. */
function sameRules(a: PersonalRules, b: PersonalRules): boolean {
  const plain = (r: PersonalRules) => JSON.stringify([r.filters ?? [], r.filters?.length ? (r.filterCombinator ?? "and") : "and", r.sorts ?? []]);
  return plain(a) === plain(b);
}

// The page redraws with every change of its address, a row opening beside the view among them;
// a view, with its hundreds of rows, only when what it's given changes.
// The table, gallery and list views come with the page; the others load when one is first shown,
// and in the background once a database that has one has loaded, so opening its tab doesn't wait.
const VIEW_LOADERS: Partial<Record<ViewType, () => Promise<unknown>>> = {
  board: () => import("./board-view"),
  calendar: () => import("./calendar-view"),
  chart: () => import("./chart-view"),
  form: () => import("./form-view"),
  pivot: () => import("./pivot-view"),
  timeline: () => import("./timeline-view"),
};
const BoardView = dynamic(() => import("./board-view").then((module) => module.BoardView), { loading: () => <ViewSkeleton /> });
const CalendarView = dynamic(() => import("./calendar-view").then((module) => module.CalendarView), { loading: () => <ViewSkeleton /> });
const ChartView = dynamic(() => import("./chart-view").then((module) => module.ChartView), { loading: () => <ViewSkeleton /> });
const FormView = dynamic(() => import("./form-view").then((module) => module.FormView), { loading: () => <ViewSkeleton /> });
const FormToolbar = dynamic(() => import("./form-view").then((module) => module.FormToolbar));
const PivotView = dynamic(() => import("./pivot-view").then((module) => module.PivotView), { loading: () => <ViewSkeleton /> });
const TimelineView = dynamic(() => import("./timeline-view").then((module) => module.TimelineView), { loading: () => <ViewSkeleton /> });
const MemoBoardView = memo(BoardView);
const MemoCalendarView = memo(CalendarView);
const MemoChartView = memo(ChartView);
const MemoFormView = memo(FormView);
const MemoGalleryView = memo(GalleryView);
const MemoListView = memo(ListView);
const MemoPivotView = memo(PivotView);
const MemoTableView = memo(TableView);
const MemoTimelineView = memo(TimelineView);
// Loaded when a dashboard view opens: its grid brings the chart and linked view code along.
const DashboardView = dynamic(() => import("./dashboard-view"), { loading: () => <DashboardSkeleton /> });
// Loaded when a map view opens: Leaflet (which needs a browser) comes along only then.
const MapView = memo(lazyPart(() => import("./map-view").then((m) => m.default), <MapSkeleton />));
// Opened now and then, from the layout menu and the current sprint's toolbar.
const SprintsDialog = dynamic(() => import("./sprints-dialog").then((module) => module.SprintsDialog));
const CompleteSprintDialog = dynamic(() => import("./sprints-dialog").then((module) => module.CompleteSprintDialog));
// Loaded when a feed view opens: its posts bring the Markdown renderer along.
const FeedView = memo(dynamic(() => import("./feed-view"), { loading: () => <DashboardSkeleton /> }));

/** A database shown inside a page body (see components/page/embed-blocks). */
export type DatabaseEmbed = {
  /**
   * A linked view: one view whose settings the block keeps instead of the database. Without
   * `onChange` (the reader may not edit the page) its filters, sorts and layout stay as they are.
   */
  linked?: { view: LinkedView; onChange?: (view: LinkedView) => void };
  /** Shown above the view tabs once the database has loaded (its name, a link to open it). */
  header?: (snapshot: DatabaseSnapshot) => ReactNode;
};

export function DatabasePage({
  workspaceId,
  databaseId,
  canEdit = true,
  canComment = canEdit,
  canEditStructure = canEdit,
  guest = false,
  exportable = true,
  embed,
}: {
  workspaceId: string;
  databaseId: string;
  /** False for viewers: every change is refused by the server, so the controls are hidden. */
  canEdit?: boolean;
  /** The viewer may comment on rows (and react to them in a feed); as `canEdit` unless given. */
  canComment?: boolean;
  /**
   * The viewer may change properties and views, not only rows and their values; as `canEdit` unless
   * given. "Can edit content" gives rows and values alone: the database shows as locked to them.
   */
  canEditStructure?: boolean;
  /** Guests get fewer bulk actions (no trash). */
  guest?: boolean;
  /** The workspace lets people export its pages (the selection's CSV export). */
  exportable?: boolean;
  /** Shown inside a page: the selected view stays out of the URL and new rows don't open. */
  embed?: DatabaseEmbed;
}) {
  const t = useTranslations("database");
  const locale = useLocale();
  // Mod+Alt+T opens or closes every group of the view (components/toggle-all.ts).
  useToggleAllShortcut();
  const linked = embed?.linked;
  const embedded = embed !== undefined;
  const { snapshot, rows, loadError, error, api, offlineCopyFrom } = useDatabase(databaseId, {
    covers: linked?.view.type === "gallery" && galleryCover(linked.view.config) === "first_image",
  });
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = embedded ? null : searchParams.get("view");
  const viewTypes = snapshot ? [...new Set(snapshot.views.map((v) => v.type))].sort().join() : "";
  useEffect(() => {
    for (const type of viewTypes.split(",")) void VIEW_LOADERS[type as ViewType]?.();
  }, [viewTypes]);
  // A link to an automation's run (the "For review" queue's): the automations open at it, once.
  const [openRun] = useState(() => {
    const automationId = embedded ? null : searchParams.get("automation");
    const runId = embedded ? null : searchParams.get("run");
    return automationId && runId ? { automationId, runId } : null;
  });
  const [selectedViewId, setSelectedViewId] = useState<string | null>(viewParam);
  // Form views: editors switch between building the form and filling it in.
  const [formPreview, setFormPreview] = useState(false);
  // A column's "Filter" asks the toolbar to open its filters once the new rule is in the view.
  const [filterRequest, setFilterRequest] = useState<FilterRequest | null>(null);
  // The search box: this person's, for whichever view is open, never saved (see lib/row-search).
  const [search, setSearch] = useState("");
  // Sidebar view links change only the query string, so the page stays mounted: follow the URL.
  useEffect(() => {
    if (viewParam) setSelectedViewId(viewParam);
  }, [viewParam]);

  const linkedSettings = linked?.view;
  const linkedView = useMemo<View | null>(
    () =>
      linkedSettings
        ? ({
            id: `linked:${databaseId}`,
            databaseId,
            name: t(`views.${linkedSettings.type}`),
            type: linkedSettings.type,
            config: linkedSettings.config,
            position: 0,
            createdAt: new Date(0),
          } as View)
        : null,
    [linkedSettings, databaseId, t],
  );
  const views = linkedView ? [linkedView] : (snapshot?.views ?? []);
  const savedView = views.find((v) => v.id === selectedViewId) ?? views[0] ?? null;
  useDocumentViewName(savedView?.name || null, !embedded);
  // Rows and views change through the server: offline, the database is read-only.
  const offline = useIsOffline() || offlineCopyFrom !== null;
  const readOnly = (snapshot?.database.archived ?? false) || !canEdit || offline;
  const structureReadOnly = readOnly || !canEditStructure;
  const locked = (snapshot?.database.locked ?? false) || !canEditStructure;
  // A personal view is its person's to set up, even where they may change nothing else.
  const ownView = !linked && Boolean(savedView?.ownerId) && savedView?.ownerId === snapshot?.viewerId;
  const archivedOrOffline = (snapshot?.database.archived ?? false) || offline;
  // A linked view's settings belong to the page showing it, not to the database.
  const configReadOnly = linked ? !linked.onChange : ownView ? archivedOrOffline : structureReadOnly;
  // Whoever may not change the view still filters and sorts it for themselves: their rules stay
  // here, per view, until the page closes, and replace the view's own for them alone. For those who
  // may change it (but a linked view's, which belong to the page showing it), new filters and sorts
  // are a draft the same way until they save them to the view for everyone.
  const personalRules = configReadOnly;
  const draftRules = !personalRules && !linked;
  const [ownRules, setOwnRules] = useState<Record<string, PersonalRules>>({});
  const ownViewRules = (personalRules || draftRules) && savedView ? ownRules[savedView.id] : undefined;
  const view = useMemo(
    () => (savedView && ownViewRules ? { ...savedView, config: { ...savedView.config, ...ownViewRules } } : savedView),
    [savedView, ownViewRules],
  );

  const selectView = useCallback((id: string) => {
    setSelectedViewId(id);
    if (embedded) return;
    // Shallow URL update: keeps the view shareable without a server round trip. A null state lets
    // Next sync its router with the new URL; passing its own state object would make it ignore the
    // change, and the next server action would put the old URL back.
    const url = new URL(window.location.href);
    url.searchParams.set("view", id);
    window.history.replaceState(null, "", url);
  }, [embedded]);

  const relationContext = useMemo<RelationContextValue | null>(
    () =>
      snapshot && {
        workspaceId,
        databaseId,
        databaseTitle: snapshot.database.title,
        targets: snapshot.relations,
        createRow: api.createRelatedRow,
      },
    [snapshot, workspaceId, databaseId, api.createRelatedRow],
  );

  const peopleContext = useMemo<PeopleContextValue>(
    () => ({ viewerId: snapshot?.viewerId ?? null, people: snapshot?.people ?? [] }),
    [snapshot?.viewerId, snapshot?.people],
  );

  const aiContext = useMemo<AiAutofillContextValue>(
    () => ({
      enabled: Boolean(snapshot?.ai?.enabled) && !offline,
      states: snapshot?.ai?.states ?? {},
      refresh: readOnly ? undefined : api.refreshAutofill,
    }),
    [snapshot?.ai, offline, readOnly, api.refreshAutofill],
  );

  const refetch = api.refetch;
  const accessContext = useMemo<PropertyAccessContextValue>(
    () => ({
      info: snapshot?.propertyAccess ?? {},
      restricted: snapshot?.restrictedPropertyIds ?? [],
      // Setting access is a change like any other: not offline, not in the trash.
      canManage: Boolean(snapshot?.canManageAccess) && !readOnly,
      refresh: () => void refetch(),
    }),
    [snapshot?.propertyAccess, snapshot?.restrictedPropertyIds, snapshot?.canManageAccess, readOnly, refetch],
  );

  // Changes to a linked view go to its block; the database's own views stay untouched.
  const onLinkedChange = linked?.onChange;
  const isLinked = linked !== undefined;
  const baseApi = useMemo(() => {
    if (!isLinked) return api;
    const updateView = async (v: View, patch: { name?: string; config?: ViewConfig }) => {
      if (patch.config && onLinkedChange) onLinkedChange({ type: v.type, config: patch.config });
      return null;
    };
    return { ...api, updateView: updateView as typeof api.updateView };
  }, [api, isLinked, onLinkedChange]);

  // Sprints (lib/sprints): the task database's sprint property, the view of the current sprint, and
  // whether this database holds another one's sprints. Both offer completing the current sprint.
  const [sprintsOpen, setSprintsOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const sprint = snapshot && !linked ? sprintProperty(snapshot.properties) : null;
  const sprintBoardId = sprint?.options.relation?.sprints?.boardViewId ?? null;
  const sprintsHere = Boolean(snapshot && !linked && holdsSprints(snapshot.properties, snapshot.relations));
  const onSprintBoard = !!sprint && !!view && view.id === sprintBoardId;
  // Tasks added on the current sprint's board go to that sprint (its filter reads the sprint's state).
  const [currentSprint, setCurrentSprint] = useState<{ viewId: string; sprintId: string | null } | null>(null);
  const [sprintsLoaded, setSprintsLoaded] = useState(0);
  useEffect(() => {
    if (!onSprintBoard || !sprintBoardId) return;
    let live = true;
    void getSprintsAction(databaseId).then((result) => {
      if (live && result.ok && result.data.side === "tasks" && result.data.on) {
        setCurrentSprint({ viewId: sprintBoardId, sprintId: result.data.current?.id ?? null });
      }
    });
    return () => {
      live = false;
    };
  }, [onSprintBoard, sprintBoardId, databaseId, sprintsLoaded]);
  const sprintId = sprint?.id;
  const currentSprintId = currentSprint && view?.id === currentSprint.viewId ? currentSprint.sprintId : null;

  // New rows get the values the active filters ask for, so they don't vanish right after creation.
  const viewApi = useMemo(() => {
    const fromFilters =
      view && snapshot
        ? defaultsFromFilters(
            view.config.filters,
            snapshot.properties,
            { viewerId: snapshot.viewerId },
            view.config.filterCombinator,
          )
        : {};
    // Values the viewer may not set would make the server refuse the whole row.
    const access = snapshot?.propertyAccess ?? {};
    const defaults = Object.fromEntries(
      Object.entries({ ...fromFilters, ...(sprintId && currentSprintId ? { [sprintId]: [currentSprintId] } : {}) }).filter(([id]) => atLeast(access[id]?.level ?? "edit", "edit_values")),
    );
    if (!Object.keys(defaults).length) return baseApi;
    return {
      ...baseApi,
      createRow: (input: Parameters<typeof baseApi.createRow>[0] = {}) =>
        baseApi.createRow({ ...input, properties: { ...defaults, ...input.properties } }),
    };
  }, [baseApi, view, snapshot, sprintId, currentSprintId]);

  const visibleRows = useMemo(() => {
    if (!view || !snapshot) return [];
    const shown = applyView(rows, withViewSorts(view), snapshot.properties, { viewerId: snapshot.viewerId, people: snapshot.people });
    return searchRows(shown, search, snapshot.properties, { people: snapshot.people, relations: snapshot.relations });
  }, [rows, view, snapshot, search]);
  // Each shown row's colors under the view's color rules, once per change of rows or rules. Rows
  // colored as before keep their entry, so their memoized cards don't redraw.
  const lastColors = useRef<ReadonlyMap<string, RowColors> | undefined>(undefined);
  const colorRules = view?.config.colorRules;
  const rowColors = useMemo(() => {
    const colors = colorRows(visibleRows, colorRules, snapshot?.properties ?? [], { viewerId: snapshot?.viewerId }, lastColors.current);
    lastColors.current = colors;
    return colors;
  }, [visibleRows, colorRules, snapshot?.properties, snapshot?.viewerId]);
  // Rows open beside the view in the row panel, unless the view opens them as pages; phones and
  // offline always open pages (the panel loads rows from the server).
  const rowPanel = useRowPanel();
  const sourceRef = useRef<HTMLDivElement>(null);
  // A full page keeps its view bar (tabs, toolbar, rules) in sight as it scrolls, in wider windows;
  // a table's header row stops under it, at --view-bar-height.
  const [viewBar, setViewBar] = useState<HTMLDivElement | null>(null);
  useStuckMark(viewBar);
  useLayoutEffect(() => {
    const source = sourceRef.current;
    if (!viewBar || !source) return;
    const measure = () => source.style.setProperty("--view-bar-height", `${viewBar.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewBar);
    return () => observer.disconnect();
  }, [viewBar]);
  const openRows = view ? openRowsOf(view.config) : "panel";
  const inPanel = Boolean(rowPanel?.available) && !!view && opensRows(view.type) && openRows !== "page" && !offline;
  const centered = inPanel && openRows === "center";
  const openRowTo = rowPanel?.open;
  // The same opener while rows open and close beside the view: its rows ask which one is open
  // themselves (useIsOpenRow), so a row opening doesn't redraw the whole view.
  const opener = useMemo<RowOpener>(() => {
    const href = (rowId: string) => `/w/${workspaceId}/p/${rowId}`;
    return {
      href,
      open: (rowId, event) => {
        if (event && opensNewTab(event)) return openInNewTab(href(rowId));
        if (!inPanel || !openRowTo) return router.push(href(rowId));
        const trigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
        openRowTo(rowId, { source: trigger?.closest("[data-row-source]") ?? sourceRef.current, trigger });
      },
      openPage: (rowId) => router.push(href(rowId)),
      inPanel,
      centered,
    };
  }, [workspaceId, inPanel, centered, openRowTo, router]);
  // The panel's previous and next rows follow the view.
  const rowsChanged = rowPanel?.rowsChanged;
  useEffect(() => {
    rowsChanged?.();
  }, [rowsChanged, visibleRows, view?.id, view?.config]);

  // The properties in the view's column order: what its columns, cards and properties menu show.
  const viewProperties = useMemo(
    () => orderProperties(snapshot?.properties ?? [], view?.config.propertyOrder),
    // Not the whole snapshot: a changed row would give every card new properties to redraw with.
    [snapshot?.properties, view?.config.propertyOrder],
  );

  const timeZone = useViewerTimeZone();
  // Just what the view shows: its rows (filtered, sorted, searched) and its shown properties, in its order.
  const exportView = useCallback(
    async (format: ViewExportFormat) => {
      if (!view) return;
      try {
        const res = await fetch(`/w/${workspaceId}/p/${databaseId}/export?view=1${format === "csv" ? "" : `&format=${format}`}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows: visibleRows.map((row) => row.id),
            properties: viewProperties.filter((p) => !isHiddenInView(view, p)).map((p) => p.id),
            name: view.name,
            // A pivot exports its table, worked out on the server from these rows.
            ...(view.type === "pivot" ? { pivot: view.config, timeZone } : {}),
          }),
        });
        await saveDownload(res, `export.${format}`);
      } catch (error) {
        api.showError(t(error instanceof Error && error.message === "disabled" ? "bulk.exportDisabled" : "bulk.exportFailed"));
      }
    },
    [view, workspaceId, databaseId, visibleRows, viewProperties, timeZone, api, t],
  );
  // Views with rows to list, and pivots' tables; a chart, a dashboard and a form show something else.
  const exportsRows = !!view && view.type !== "chart" && view.type !== "dashboard" && view.type !== "form";

  // What the views are given stays the same from one render of the page to the next (see MemoBoardView).
  const setConfig = useCallback(
    async (v: View, config: ViewConfig) => {
      const { filters, filterCombinator, sorts } = config;
      if (personalRules) {
        setOwnRules((all) => ({ ...all, [v.id]: { filters, filterCombinator, sorts } }));
        return null;
      }
      const saved = snapshot?.views.find((other) => other.id === v.id);
      if (!draftRules || !saved) return baseApi.updateView(v, { config });
      // The rules go to the draft (none when they are the view's own again), anything else to the view.
      const rules = { filters, filterCombinator, sorts };
      const own = { filters: saved.config.filters, filterCombinator: saved.config.filterCombinator, sorts: saved.config.sorts };
      setOwnRules((all) => {
        const rest = { ...all };
        if (sameRules(rules, own)) delete rest[v.id];
        else rest[v.id] = rules;
        return rest;
      });
      const others = { ...config, ...own };
      if (JSON.stringify(others) === JSON.stringify({ ...saved.config, ...own })) return null;
      return baseApi.updateView(saved, { config: others });
    },
    [baseApi, personalRules, draftRules, snapshot?.views],
  );
  // Saves the draft's filters and sorts to the view, for everyone.
  const saveDraft = useCallback(
    async (v: View) => {
      const saved = snapshot?.views.find((other) => other.id === v.id);
      const rules = ownRules[v.id];
      if (!saved || !rules) return;
      // The view takes the rules at once (updateView shows them before the server answers).
      setOwnRules((all) => {
        const rest = { ...all };
        delete rest[v.id];
        return rest;
      });
      await baseApi.updateView(saved, { config: { ...saved.config, ...rules } });
    },
    [baseApi, ownRules, snapshot?.views],
  );
  const properties = snapshot?.properties;
  // Adds a rule on the column with its first operator, like the filter menu's "Add filter".
  const filterBy = useCallback(
    (v: View, columnId: string) => {
      const prop = properties?.find((p) => p.id === columnId);
      const [first] = filterOperators(prop ? valueType(prop) : "title");
      if (!first) return; // a button: nothing to filter by
      const filters = [...(v.config.filters ?? []), { propertyId: columnId, op: first.op }];
      void setConfig(v, { ...v.config, filters });
      setFilterRequest((r) => ({ id: (r?.id ?? 0) + 1, viewId: v.id, filters: filters.length }));
    },
    [properties, setConfig],
  );
  const filterViewBy = useCallback((columnId: string) => void (view && filterBy(view, columnId)), [view, filterBy]);

  const createGroupProperty = useCallback(async () => {
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set((properties ?? []).map((p) => lower(p.name)));
    const status = t("page.defaultGroupProperty");
    const name = names.has(lower(status)) ? t("page.defaultGroupPropertyFallback") : status;
    const created = await api.addProperty(name, "select", [
      t("page.defaultGroupOptions.notStarted"),
      t("page.defaultGroupOptions.inProgress"),
      t("page.defaultGroupOptions.done"),
    ]);
    if (created && (view?.type === "board" || view?.type === "table" || view?.type === "chart" || view?.type === "pivot")) {
      await setConfig(view, { ...view.config, groupBy: created.id });
    }
  }, [locale, properties, t, api, view, setConfig]);

  const createDateProperty = useCallback(async () => {
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set((properties ?? []).map((p) => lower(p.name)));
    // A timeline takes a new date property as its start, or as its end once it has a start.
    const asEnd = view?.type === "timeline" && !!timelineDates(view, properties ?? []).start;
    const base = t(asEnd ? "calendar.defaultEndProperty" : "calendar.defaultDateProperty");
    let name = base;
    for (let i = 2; names.has(lower(name)); i++) name = `${base} ${i}`;
    const created = await api.addProperty(name, "date");
    if (created && view?.type === "calendar") await setConfig(view, { ...view.config, dateBy: created.id });
    if (created && view?.type === "timeline") {
      await setConfig(view, { ...view.config, ...(asEnd ? { endDateBy: created.id } : { dateBy: created.id }) });
    }
  }, [locale, properties, t, api, view, setConfig]);

  const createPlaceProperty = useCallback(async () => {
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set((properties ?? []).map((p) => lower(p.name)));
    const base = t("map.defaultPlaceProperty");
    let name = base;
    for (let i = 2; names.has(lower(name)); i++) name = `${base} ${i}`;
    const created = await api.addProperty(name, "place");
    if (created && view?.type === "map") await setConfig(view, { ...view.config, placeBy: created.id });
  }, [locale, properties, t, api, view, setConfig]);

  if (!snapshot) {
    return (
      <div className="page-gutter">
        {loadError ? (
          <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-muted">
            <TriangleAlert className="h-4 w-4 text-danger" />
            {t("page.loadError", { error: loadError })}
            <Button size="sm" variant="ghost" onClick={() => void api.refetch()}>
              {t("page.retry")}
            </Button>
          </div>
        ) : (
          <DatabaseSkeleton />
        )}
      </div>
    );
  }

  // Deleted properties and views, for those who may change the schema (as deleting them took).
  const deletedSchema =
    !structureReadOnly && !locked && !linked
      ? {
          databaseId,
          reloadKey: `${snapshot.properties.map((p) => p.id).join()}|${snapshot.views.map((v) => v.id).join()}`,
          onChanged: () => void api.refetch(),
        }
      : undefined;
  // Automations belong to the database, not to a page showing one of its views; full access only.
  const canManageAutomations = Boolean(snapshot.canManageAccess) && !structureReadOnly && !linked;

  const addView = async (type: ViewType, personal = false) => {
    // Names for new views follow the UI language; existing names are stored data and stay as-is.
    const base = t(`views.${type}`);
    const taken = new Set(views.map((v) => v.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    const created = await api.addView(name, type, personal);
    if (created) selectView(created.id);
  };

  const duplicateView = async (v: View) => {
    const taken = new Set(views.map((other) => other.name));
    let name = t("viewTabs.copyName", { name: v.name });
    for (let i = 2; taken.has(name); i++) name = `${t("viewTabs.copyName", { name: v.name })} ${i}`;
    const created = await api.duplicateView(v, name);
    if (created) selectView(created.id);
  };

  const deleteView = async (v: View) => {
    if (v.id === view?.id) {
      const next = views.find((x) => x.id !== v.id);
      if (next) selectView(next.id);
    }
    await api.deleteView(v.id);
  };

  /**
   * "New": from the default row template when there is one, the view's own before the database's
   * (a linked view has none of its own); the menu beside it picks another or none.
   */
  const newRow = async (template?: string | null) => {
    const viewId = view && !linked ? view.id : undefined;
    const id = await viewApi.createRow(template === undefined ? { useDefault: true, viewId } : { templateId: template });
    if (!id) return;
    // Beside the view in the panel, ready for its name. Otherwise, inside a page the new row shows
    // up in place: leaving the page would lose the reader's spot.
    if (inPanel) {
      markNewPage(id);
      opener.open(id);
    } else if (!embedded) {
      markNewPage(id);
      router.push(`/w/${workspaceId}/p/${id}`);
    }
  };

  return (
    <RelationProvider value={relationContext}>
      <PeopleProvider value={peopleContext}>
        <SchemaProvider value={snapshot.properties}>
          <PropertyAccessProvider value={accessContext}>
            <AiAutofillProvider value={aiContext}>
            <ButtonAutomationsProvider
              workspaceId={workspaceId}
              databaseId={databaseId}
              databaseTitle={snapshot.database.title}
              enabled={canManageAutomations}
            >
              {/* Wide layout: controls sit in the page gutter, the board scrolls edge to edge. */}
              <RowOpenerContext value={opener}>
                <div ref={sourceRef} data-row-source data-open-rows={centered ? "center" : undefined} className="min-w-0">
                  {/* Under the page's top bar (h-11, z-35) and over frozen columns and the header row
                      (z-30, z-31); opaque while stuck, so rows don't show through. */}
                  <div
                    ref={embedded ? undefined : setViewBar}
                    className={cn("page-gutter", !embedded && "md:sticky md:top-11 md:z-[34] md:pb-2 md:data-stuck:bg-bg")}
                  >
                    {embed?.header?.(snapshot)}
                    {offline && <OfflineNotice savedAt={offlineCopyFrom} />}
                    {/* Phones stack the toolbar above the tabs so the tabs get the whole row. */}
                    <div className="flex flex-col-reverse gap-1 md:flex-row md:items-end md:justify-between md:gap-2">
                      <ViewTabs
                        views={views}
                        activeId={view?.id ?? ""}
                        readOnly={readOnly || locked || !!linked}
                        onSelect={selectView}
                        onAdd={addView}
                        onRename={(v, name) => api.updateView(v, { name })}
                        onIcon={(v, icon) => api.updateView(v, { config: { ...v.config, icon: icon ?? undefined } })}
                        onMove={(id, target, side) => api.moveView(id, target, side)}
                        deleted={deletedSchema}
                        onExport={exportable && exportsRows && !offline ? exportView : undefined}
                        onDuplicate={duplicateView}
                        onDelete={deleteView}
                        viewerId={snapshot.viewerId}
                        canAddPersonal={!linked && !archivedOrOffline}
                        onShare={readOnly || locked || linked ? undefined : (v) => void api.shareView(v)}
                      />
                      {view?.type === "dashboard" && canManageAutomations && (
                        <div className="flex shrink-0 items-center gap-1 self-end md:pb-1.5">
                          <AutomationsButton workspaceId={workspaceId} databaseId={databaseId} databaseTitle={snapshot.database.title} openRun={openRun} />
                        </div>
                      )}
                      {view?.type === "form" && (
                        <div className="flex shrink-0 items-center gap-1 self-end md:pb-1.5">
                          <FormToolbar
                            view={view}
                            properties={snapshot.properties}
                            workspaceId={workspaceId}
                            databaseId={databaseId}
                            editable={!structureReadOnly}
                            preview={formPreview}
                            onPreview={setFormPreview}
                          />
                          {canManageAutomations && (
                            <AutomationsButton
                              workspaceId={workspaceId}
                              databaseId={databaseId}
                              databaseTitle={snapshot.database.title}
                              openRun={openRun}
                            />
                          )}
                        </div>
                      )}
                      {view && view.type !== "form" && view.type !== "dashboard" && (
                        <div className="relative flex shrink-0 items-center gap-1 self-end md:pb-1.5">
                          <ViewSearch value={search} onChange={setSearch} />
                          <ViewToolbar
                            view={view}
                            properties={viewProperties}
                            readOnly={configReadOnly}
                            personal={personalRules}
                            onConfig={(config) => setConfig(view, config)}
                            filterRequest={filterRequest}
                            deleted={deletedSchema}
                          />
                          <ViewLayoutMenu
                            view={view}
                            properties={snapshot.properties}
                            viewProperties={viewProperties}
                            readOnly={configReadOnly}
                            locked={locked}
                            onConfig={(config) => setConfig(view, config)}
                            onType={linked ? undefined : (type) => void api.updateView(view, { type })}
                            onCreateGroupProperty={createGroupProperty}
                            onCreateDateProperty={createDateProperty}
                            deleted={deletedSchema}
                            onDuplicate={readOnly || locked || linked ? undefined : () => void duplicateView(view)}
                            onDelete={readOnly || locked || linked || views.length < 2 ? undefined : () => void deleteView(view)}
                            onCreatePlaceProperty={structureReadOnly ? undefined : createPlaceProperty}
                            onSubItems={structureReadOnly ? undefined : (on, propertyId) => void api.setSubItems(on, propertyId)}
                            onDependencies={structureReadOnly ? undefined : (on, input) => void api.setDependencies(on, input)}
                            onSprints={structureReadOnly || linked ? undefined : () => setSprintsOpen(true)}
                          />
                          {!structureReadOnly && (onSprintBoard || sprintsHere) && (
                            <Button size="sm" variant="ghost" onClick={() => setCompleteOpen(true)} title={t("sprints.complete")}>
                              <FlagTriangleRight className="h-3.5 w-3.5" />
                              <span className="hidden lg:inline">{t("sprints.complete")}</span>
                            </Button>
                          )}
                          {snapshot.sync && !linked && (
                            <JiraSyncButton databaseId={databaseId} sync={snapshot.sync} onChanged={() => void api.refetch()} />
                          )}
                          {canManageAutomations && (
                            <AutomationsButton
                              workspaceId={workspaceId}
                              databaseId={databaseId}
                              databaseTitle={snapshot.database.title}
                              openRun={openRun}
                            />
                          )}
                          {!readOnly && (
                            <div className="ms-1 flex items-center">
                              <Button size="sm" variant="primary" onClick={() => void newRow()} className="rounded-e-none">
                                <Plus className="h-3.5 w-3.5" />
                                {t("page.new")}
                              </Button>
                              <RowTemplatesMenu
                                workspaceId={workspaceId}
                                snapshot={snapshot}
                                view={view && !linked && !configReadOnly ? view : null}
                                onViewDefault={(v, defaultTemplateId) => void api.updateView(v, { config: { ...v.config, defaultTemplateId } })}
                                onCreate={(templateId) => void newRow(templateId)}
                                onChanged={() => void api.refetch()}
                                onError={api.showError}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {error && (
                      <div
                        role="alert"
                        className="mt-2 flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm"
                      >
                        <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
                        <span className="flex-1">{error}</span>
                        <button
                          type="button"
                          aria-label={t("page.dismiss")}
                          onClick={api.clearError}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}

                    {view && view.type !== "form" && view.type !== "dashboard" && (
                      <ActiveRulesBar
                        view={view}
                        properties={snapshot.properties}
                        onReset={
                          ownViewRules
                            ? () =>
                                setOwnRules((all) => {
                                  const rest = { ...all };
                                  delete rest[view.id];
                                  return rest;
                                })
                            : undefined
                        }
                        onSave={ownViewRules && draftRules ? () => void saveDraft(view) : undefined}
                        onConfig={(config) => setConfig(view, config)}
                      />
                    )}
                  </div>

                  <div className={cn("pt-2", !embedded && "md:pt-0")}>
                    {!view ? (
                      <div className="page-gutter py-10 text-center text-sm text-fg-muted">
                        {t("page.noViews")}
                        {!structureReadOnly && (
                          <div className="mt-3">
                            <Button size="sm" onClick={() => addView("table")}>
                              <Plus className="h-3.5 w-3.5" />
                              {t("page.addTableView")}
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : view.type === "form" ? (
                      <MemoFormView
                        key={view.id}
                        view={view}
                        properties={snapshot.properties}
                        databaseTitle={snapshot.database.title}
                        api={api}
                        editable={!readOnly}
                        buildable={!structureReadOnly}
                        archived={snapshot.database.archived}
                        preview={formPreview}
                      />
                    ) : view.type === "board" ? (
                      <MemoBoardView
                        colors={rowColors}
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        api={viewApi}
                        readOnly={readOnly}
                        locked={locked}
                        onCreateGroupProperty={createGroupProperty}
                      />
                    ) : view.type === "gallery" ? (
                      <MemoGalleryView
                        colors={rowColors}
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        api={viewApi}
                        readOnly={readOnly}
                      />
                    ) : view.type === "list" ? (
                      <MemoListView
                        colors={rowColors}
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        allRows={rows}
                        api={viewApi}
                        readOnly={readOnly}
                      />
                    ) : view.type === "timeline" ? (
                      <MemoTimelineView
                        colors={rowColors}
                        key={view.id}
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        allRows={rows}
                        api={viewApi}
                        readOnly={readOnly}
                        locked={locked}
                        onCreateDateProperty={createDateProperty}
                      />
                    ) : view.type === "feed" ? (
                      <FeedView
                        colors={rowColors}
                        workspaceId={workspaceId}
                        databaseId={databaseId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        readOnly={readOnly}
                        canComment={canComment && !offline && !snapshot.database.archived}
                      />
                    ) : view.type === "map" ? (
                      <MapView
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        tiles={snapshot.map ?? null}
                        api={viewApi}
                        readOnly={readOnly}
                        locked={locked}
                        onCreatePlaceProperty={createPlaceProperty}
                      />
                    ) : view.type === "chart" ? (
                      <MemoChartView
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        readOnly={readOnly}
                        locked={locked}
                        onCreateGroupProperty={createGroupProperty}
                      />
                    ) : view.type === "pivot" ? (
                      <MemoPivotView
                        workspaceId={workspaceId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        readOnly={readOnly}
                        locked={locked}
                        onCreateGroupProperty={createGroupProperty}
                      />
                    ) : view.type === "dashboard" ? (
                      <DashboardView
                        key={view.id}
                        workspaceId={workspaceId}
                        view={view}
                        readOnly={configReadOnly}
                        onConfig={(config) => void setConfig(view, config)}
                      />
                    ) : view.type === "calendar" ? (
                      <div className="page-gutter">
                        <MemoCalendarView
                        colors={rowColors}
                          workspaceId={workspaceId}
                          view={view}
                          properties={viewProperties}
                          rows={visibleRows}
                          api={viewApi}
                          readOnly={readOnly}
                          locked={locked}
                          onCreateDateProperty={createDateProperty}
                        />
                      </div>
                    ) : (
                      <MemoTableView
                        colors={rowColors}
                        workspaceId={workspaceId}
                        databaseId={databaseId}
                        view={view}
                        properties={viewProperties}
                        rows={visibleRows}
                        allRows={rows}
                        api={viewApi}
                        readOnly={readOnly}
                        settingsReadOnly={configReadOnly}
                        locked={locked}
                        filtered={rows.length > 0}
                        searched={search.trim() !== ""}
                        guest={guest}
                        exportable={exportable}
                        onFilter={filterViewBy}
                      />
                    )}
                  </div>
                </div>
                {sprintsOpen && (
                  <SprintsDialog
                    workspaceId={workspaceId}
                    databaseId={databaseId}
                    onClose={() => setSprintsOpen(false)}
                    onChanged={(viewId) => {
                      void api.refetch().then(() => viewId && selectView(viewId));
                    }}
                  />
                )}
                {completeOpen && (
                  <CompleteSprintDialog
                    databaseId={databaseId}
                    onClose={() => setCompleteOpen(false)}
                    onDone={() => {
                      void api.refetch();
                      setSprintsLoaded((n) => n + 1);
                    }}
                  />
                )}
              </RowOpenerContext>
            </ButtonAutomationsProvider>
            </AiAutofillProvider>
          </PropertyAccessProvider>
        </SchemaProvider>
      </PeopleProvider>
    </RelationProvider>
  );
}

function DashboardSkeleton() {
  const t = useTranslations("database.page");
  return (
    <div aria-busy="true" aria-label={t("loading")} className="page-gutter">
      <div className="h-28 animate-pulse rounded-lg bg-bg-subtle" />
    </div>
  );
}

function MapSkeleton() {
  const t = useTranslations("database.map");
  return (
    <div aria-busy="true" aria-label={t("loading")} className="page-gutter">
      <div className="h-[min(70vh,640px)] min-h-72 animate-pulse rounded-lg bg-bg-subtle" />
    </div>
  );
}

function ViewSkeleton() {
  const t = useTranslations("database.page");
  return (
    <div aria-busy="true" aria-label={t("loading")} className="mt-3 animate-pulse space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-7 rounded-md bg-bg-subtle" />
      ))}
    </div>
  );
}

function DatabaseSkeleton() {
  const t = useTranslations("database.page");
  return (
    <div aria-busy="true" aria-label={t("loading")} className="animate-pulse">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <div className="h-6 w-20 rounded-md bg-bg-hover" />
        <div className="h-6 w-16 rounded-md bg-bg-hover" />
      </div>
      <div className="mt-3 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-7 rounded-md bg-bg-subtle" />
        ))}
      </div>
    </div>
  );
}

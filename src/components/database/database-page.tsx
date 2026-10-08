"use client";

import { Plus, TriangleAlert, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { useDocumentViewName } from "@/components/page/document-title";
import { markNewPage } from "@/components/page/new-page-focus";
import type { ViewConfig, ViewType } from "@/db/schema/app";
import type { LinkedView } from "@/lib/embed-blocks";
import { valueType } from "@/lib/derived";
import { applyView, defaultsFromFilters, filterOperators, orderProperties } from "@/lib/properties";
import { atLeast } from "@/lib/property-access";
import { galleryCover } from "@/lib/views";
import { AutomationsButton } from "./automations-dialog";
import { BoardView } from "./board-view";
import { CalendarView } from "./calendar-view";
import { ChartView } from "./chart-view";
import { FormToolbar, FormView } from "./form-view";
import { GalleryView } from "./gallery-view";
import { ListView } from "./list-view";
import { RowTemplatesMenu } from "./row-templates-menu";
import { PeopleProvider, type PeopleContextValue } from "./person-cell";
import { RelationProvider, type RelationContextValue } from "./relation-context";
import { PropertyAccessProvider, type PropertyAccessContextValue } from "./property-access";
import { SchemaProvider } from "./schema-context";
import { TableView } from "./table-view";
import { TimelineView } from "./timeline-view";
import type { DatabaseSnapshot, View } from "./types";
import { useDatabase } from "./use-database";
import { OfflineNotice } from "@/components/offline/offline-notice";
import { AiAutofillProvider, type AiAutofillContextValue } from "./ai-autofill";
import { useIsOffline } from "@/components/offline/offline-context";
import { ActiveRulesBar, ViewTabs, ViewToolbar, type FilterRequest } from "./view-bar";
import { timelineDates, ViewLayoutMenu } from "./view-settings";

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
  guest = false,
  exportable = true,
  embed,
}: {
  workspaceId: string;
  databaseId: string;
  /** False for viewers: every change is refused by the server, so the controls are hidden. */
  canEdit?: boolean;
  /** Guests get fewer bulk actions (no trash). */
  guest?: boolean;
  /** The workspace lets people export its pages (the selection's CSV export). */
  exportable?: boolean;
  /** Shown inside a page: the selected view stays out of the URL and new rows don't open. */
  embed?: DatabaseEmbed;
}) {
  const t = useTranslations("database");
  const locale = useLocale();
  const linked = embed?.linked;
  const embedded = embed !== undefined;
  const { snapshot, rows, loadError, error, api, offlineCopyFrom } = useDatabase(databaseId, {
    covers: linked?.view.type === "gallery" && galleryCover(linked.view.config) === "first_image",
  });
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = embedded ? null : searchParams.get("view");
  const [selectedViewId, setSelectedViewId] = useState<string | null>(viewParam);
  // Form views: editors switch between building the form and filling it in.
  const [formPreview, setFormPreview] = useState(false);
  // A column's "Filter" asks the toolbar to open its filters once the new rule is in the view.
  const [filterRequest, setFilterRequest] = useState<FilterRequest | null>(null);
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
  const view = views.find((v) => v.id === selectedViewId) ?? views[0] ?? null;
  useDocumentViewName(view?.name || null, !embedded);
  // Rows and views change through the server: offline, the database is read-only.
  const offline = useIsOffline() || offlineCopyFrom !== null;
  const readOnly = (snapshot?.database.archived ?? false) || !canEdit || offline;
  const locked = snapshot?.database.locked ?? false;
  // A linked view's settings belong to the page showing it, not to the database.
  const configReadOnly = linked ? !linked.onChange : readOnly;

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
      Object.entries(fromFilters).filter(([id]) => atLeast(access[id]?.level ?? "edit", "edit_values")),
    );
    if (!Object.keys(defaults).length) return baseApi;
    return {
      ...baseApi,
      createRow: (input: Parameters<typeof baseApi.createRow>[0] = {}) =>
        baseApi.createRow({ ...input, properties: { ...defaults, ...input.properties } }),
    };
  }, [baseApi, view, snapshot]);

  const visibleRows = useMemo(() => {
    if (!view || !snapshot) return [];
    return applyView(rows, view.config, snapshot.properties, { viewerId: snapshot.viewerId, people: snapshot.people });
  }, [rows, view, snapshot]);
  // The properties in the view's column order: what its columns, cards and properties menu show.
  const viewProperties = useMemo(
    () => (snapshot ? orderProperties(snapshot.properties, view?.config.propertyOrder) : []),
    [snapshot, view?.config.propertyOrder],
  );

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

  const setConfig = (v: View, config: ViewConfig) => baseApi.updateView(v, { config });
  // Adds a rule on the column with its first operator, like the filter menu's "Add filter".
  const filterBy = (v: View, columnId: string) => {
    const prop = snapshot.properties.find((p) => p.id === columnId);
    const filters = [...(v.config.filters ?? []), { propertyId: columnId, op: filterOperators(prop ? valueType(prop) : "title")[0].op }];
    void setConfig(v, { ...v.config, filters });
    setFilterRequest((r) => ({ id: (r?.id ?? 0) + 1, viewId: v.id, filters: filters.length }));
  };
  // Automations belong to the database, not to a page showing one of its views; full access only.
  const canManageAutomations = Boolean(snapshot.canManageAccess) && !readOnly && !linked;

  const addView = async (type: ViewType) => {
    // Names for new views follow the UI language; existing names are stored data and stay as-is.
    const base = t(`views.${type}`);
    const taken = new Set(views.map((v) => v.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    const created = await api.addView(name, type);
    if (created) selectView(created.id);
  };

  const createGroupProperty = async () => {
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set(snapshot.properties.map((p) => lower(p.name)));
    const status = t("page.defaultGroupProperty");
    const name = names.has(lower(status)) ? t("page.defaultGroupPropertyFallback") : status;
    const created = await api.addProperty(name, "select", [
      t("page.defaultGroupOptions.notStarted"),
      t("page.defaultGroupOptions.inProgress"),
      t("page.defaultGroupOptions.done"),
    ]);
    if (created && (view?.type === "board" || view?.type === "table" || view?.type === "chart")) {
      await setConfig(view, { ...view.config, groupBy: created.id });
    }
  };

  const createDateProperty = async () => {
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set(snapshot.properties.map((p) => lower(p.name)));
    // A timeline takes a new date property as its start, or as its end once it has a start.
    const asEnd = view?.type === "timeline" && !!timelineDates(view, snapshot.properties).start;
    const base = t(asEnd ? "calendar.defaultEndProperty" : "calendar.defaultDateProperty");
    let name = base;
    for (let i = 2; names.has(lower(name)); i++) name = `${base} ${i}`;
    const created = await api.addProperty(name, "date");
    if (created && view?.type === "calendar") await setConfig(view, { ...view.config, dateBy: created.id });
    if (created && view?.type === "timeline") {
      await setConfig(view, { ...view.config, ...(asEnd ? { endDateBy: created.id } : { dateBy: created.id }) });
    }
  };

  /** "New": from the default row template when there is one; the menu beside it picks another or none. */
  const newRow = async (template?: string | null) => {
    const id = await viewApi.createRow(template === undefined ? { useDefault: true } : { templateId: template });
    // Inside a page the new row shows up in place; leaving the page would lose the reader's spot.
    if (id && !embedded) {
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
              {/* Wide layout: controls sit in the page gutter, the board scrolls edge to edge. */}
              <div className="min-w-0">
                <div className="page-gutter">
                  {embed?.header?.(snapshot)}
                  {offline && <OfflineNotice savedAt={offlineCopyFrom} />}
                  {/* Phones stack the toolbar above the tabs so the tabs get the whole row. */}
                  <div className="flex flex-col-reverse gap-1 border-b border-border md:flex-row md:items-end md:justify-between md:gap-2">
                    <ViewTabs
                      views={views}
                      activeId={view?.id ?? ""}
                      readOnly={readOnly || locked || !!linked}
                      onSelect={selectView}
                      onAdd={addView}
                      onRename={(v, name) => api.updateView(v, { name })}
                      onMove={(id, target, side) => api.moveView(id, target, side)}
                      onDelete={async (v) => {
                        if (v.id === view?.id) {
                          const next = views.find((x) => x.id !== v.id);
                          if (next) selectView(next.id);
                        }
                        await api.deleteView(v.id);
                      }}
                    />
                    {view?.type === "form" && (
                      <div className="flex shrink-0 items-center gap-1 self-end md:pb-1.5">
                        <FormToolbar
                          view={view}
                          properties={snapshot.properties}
                          workspaceId={workspaceId}
                          databaseId={databaseId}
                          editable={!readOnly}
                          preview={formPreview}
                          onPreview={setFormPreview}
                        />
                        {canManageAutomations && (
                          <AutomationsButton
                            workspaceId={workspaceId}
                            databaseId={databaseId}
                            databaseTitle={snapshot.database.title}
                          />
                        )}
                      </div>
                    )}
                    {view && view.type !== "form" && (
                      <div className="flex shrink-0 items-center gap-1 self-end md:pb-1.5">
                        <ViewToolbar
                          view={view}
                          properties={viewProperties}
                          readOnly={configReadOnly}
                          locked={locked}
                          onConfig={(config) => setConfig(view, config)}
                          filterRequest={filterRequest}
                          onCreateGroupProperty={createGroupProperty}
                          onCreateDateProperty={createDateProperty}
                        />
                        <ViewLayoutMenu
                          view={view}
                          properties={snapshot.properties}
                          readOnly={configReadOnly}
                          locked={locked}
                          onConfig={(config) => setConfig(view, config)}
                          onCreateDateProperty={createDateProperty}
                          onSubItems={readOnly ? undefined : (on, propertyId) => void api.setSubItems(on, propertyId)}
                        />
                        {canManageAutomations && (
                          <AutomationsButton
                            workspaceId={workspaceId}
                            databaseId={databaseId}
                            databaseTitle={snapshot.database.title}
                          />
                        )}
                        {!readOnly && (
                          <div className="ml-1 flex items-center">
                            <Button size="sm" variant="primary" onClick={() => void newRow()} className="rounded-r-none">
                              <Plus className="h-3.5 w-3.5" />
                              {t("page.new")}
                            </Button>
                            <RowTemplatesMenu
                              workspaceId={workspaceId}
                              snapshot={snapshot}
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

                  {view && view.type !== "form" && (
                    <ActiveRulesBar
                      view={view}
                      properties={snapshot.properties}
                      readOnly={configReadOnly}
                      onConfig={(config) => setConfig(view, config)}
                    />
                  )}
                </div>

                <div className="pt-2">
                  {!view ? (
                    <div className="page-gutter py-10 text-center text-sm text-fg-muted">
                      {t("page.noViews")}
                      {!readOnly && (
                        <div className="mt-3">
                          <Button size="sm" onClick={() => addView("table")}>
                            <Plus className="h-3.5 w-3.5" />
                            {t("page.addTableView")}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : view.type === "form" ? (
                    <FormView
                      key={view.id}
                      view={view}
                      properties={snapshot.properties}
                      databaseTitle={snapshot.database.title}
                      api={api}
                      editable={!readOnly}
                      archived={snapshot.database.archived}
                      preview={formPreview}
                    />
                  ) : view.type === "board" ? (
                    <BoardView
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
                    <GalleryView
                      workspaceId={workspaceId}
                      view={view}
                      properties={viewProperties}
                      rows={visibleRows}
                      api={viewApi}
                      readOnly={readOnly}
                    />
                  ) : view.type === "list" ? (
                    <ListView
                      workspaceId={workspaceId}
                      view={view}
                      properties={viewProperties}
                      rows={visibleRows}
                      allRows={rows}
                      api={viewApi}
                      readOnly={readOnly}
                    />
                  ) : view.type === "timeline" ? (
                    <TimelineView
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
                  ) : view.type === "chart" ? (
                    <ChartView
                      workspaceId={workspaceId}
                      view={view}
                      properties={viewProperties}
                      rows={visibleRows}
                      readOnly={readOnly}
                      locked={locked}
                      onCreateGroupProperty={createGroupProperty}
                    />
                  ) : view.type === "calendar" ? (
                    <div className="page-gutter">
                      <CalendarView
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
                    <TableView
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
                      guest={guest}
                      exportable={exportable}
                      onFilter={(columnId) => filterBy(view, columnId)}
                    />
                  )}
                </div>
              </div>
            </AiAutofillProvider>
          </PropertyAccessProvider>
        </SchemaProvider>
      </PeopleProvider>
    </RelationProvider>
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

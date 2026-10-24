"use client";

import { ChevronDown, ChevronRight, MessageSquare, PanelRight, PanelTop, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addPropertyAction,
  createRowAction,
  ensureOptionAction,
  loadRowAction,
  setPropertiesBesideAction,
  setPropertyPinnedAction,
  updatePropertyAction,
  updateRowPropertiesAction,
} from "@/app/actions/databases";
import { addAutofillPropertyAction, refreshAutofillAction } from "@/app/actions/ai";
import { useChannel, useChannels } from "@/components/collab/use-channel";
import { useIsOffline, useOffline } from "@/components/offline/offline-context";
import { OfflineNotice } from "@/components/offline/offline-notice";
import { deleteSnapshot, loadSnapshot, rowSnapshotKey, saveSnapshot } from "@/components/offline/offline-store";
import type { AiAutofillConfig } from "@/lib/ai";
import { relatedSchemasFrom, withFormulas } from "@/lib/derived";
import type { FormulaStyle } from "@/lib/formula";
import { rowPageSections, type PageVisibility } from "@/lib/page-visibility";
import { canPin, pinnedSplit } from "@/lib/row-layout";
import { useRowLayoutHost } from "@/components/page/row-layout-context";
import { cn } from "@/components/ui";
import type { PropertyType, SelectOption } from "@/db/schema/app";
import { AiAutofillProvider, AiCell, type AiAutofillContextValue } from "./ai-autofill";
import { Floating, useFloating } from "./floating";
import { PeopleProvider, type PeopleContextValue } from "./person-cell";
import { uploadToPage } from "./files-cell";
import { PropertyAccessProvider, PropertyLock, usePropertyAccess, type PropertyAccessContextValue } from "./property-access";
import { isEmptyValue, PropertyCell } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import { usePropertyHint } from "./property-hint";
import { AddPropertyPanel, PropertyMenu } from "./property-menu";
import { RelationProvider, type RelationContextValue } from "./relation-context";
import { RowActivity } from "./row-activity";
import { RowReviewBanner } from "@/components/review/row-review-banner";
import { RowEmails } from "./row-emails";
import { SchemaProvider } from "./schema-context";
import { RowCellProvider } from "./row-cell-context";
import { rowSnapshotOf, type RowSnapshot as Loaded } from "./row-snapshot";
import type { DerivedInput, Property, RelationInput } from "./types";
import { usePropertyThreadCount } from "@/components/page/property-threads";
import { requestPropertyComment } from "@/lib/comments-request";

// Only URL properties set to show previews need it: kept out of the row panel's first load.
const UrlPreview = dynamic(() => import("./url-preview"), { ssr: false });
// Only relations shown as a section of their own need it (lib/relation-options).
const RelationSection = dynamic(() => import("./relation-section"), { ssr: false });

/**
 * Editable property list of a database row's page: the properties its database pins in a strip under
 * the title, then the others above the body or, as the database sets it, beside it (lib/row-layout).
 */
export function RowProperties({
  workspaceId,
  databaseId,
  rowId,
  readOnly: readOnlyProp,
}: {
  workspaceId: string;
  databaseId: string;
  rowId: string;
  readOnly?: boolean;
}) {
  const t = useTranslations("database.rowProperties");
  const offlineUser = useOffline()?.userId;
  // When the values on screen are this browser's copy from an earlier visit (read-only).
  const [offlineCopyFrom, setOfflineCopyFrom] = useState<number | null>(null);
  const offline = useIsOffline() || offlineCopyFrom !== null;
  const readOnly = readOnlyProp || offline;
  const tc = useTranslations("common");
  // Actions throw (instead of returning an error) when the session expired or the network failed.
  const safe = useCallback(
    async <T,>(action: Promise<{ ok: true; data: T } | { ok: false; error: string }>) => {
      try {
        return await action;
      } catch {
        return { ok: false as const, error: tc("genericError") };
      }
    },
    [tc],
  );
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Values written locally but not yet confirmed by a refetch.
  const [pending, setPending] = useState<Record<string, { value: unknown; version: number }>>({});
  const seq = useRef(0);
  const version = useRef(0);
  // The properties the database leaves off row pages, opened by the viewer.
  const [showMore, setShowMore] = useState(false);
  // The page around the properties draws them beside its body when the database says so.
  const layoutHost = useRowLayoutHost();
  const setBeside = layoutHost?.setBeside;
  const beside = Boolean(data?.beside);
  useEffect(() => {
    if (!setBeside) return;
    setBeside(beside);
    return () => setBeside(false);
  }, [setBeside, beside]);

  const refetch = useCallback(async () => {
    const mine = ++seq.current;
    let unreachable = false;
    const res = await safe(
      loadRowAction(rowId).catch((e: unknown) => {
        unreachable = true;
        throw e;
      }),
    );
    if (mine !== seq.current) return;
    if (res.ok) {
      const loaded = rowSnapshotOf(res.data);
      setData(loaded);
      setOfflineCopyFrom(null);
      if (offlineUser) void saveSnapshot(offlineUser, rowSnapshotKey(rowId), loaded);
      return;
    }
    // Offline: the values from the last visit, if this browser kept them.
    const kept = unreachable && offlineUser ? await loadSnapshot<Loaded>(offlineUser, rowSnapshotKey(rowId)) : null;
    if (mine !== seq.current) return;
    if (kept) {
      setData(kept.data);
      setOfflineCopyFrom(kept.savedAt);
      return;
    }
    if (!unreachable && offlineUser) void deleteSnapshot(offlineUser, rowSnapshotKey(rowId));
    setError(res.error);
  }, [rowId, safe, offlineUser]);

  // Back online: the server's values replace the offline copy.
  const browserOffline = useIsOffline();
  useEffect(() => {
    if (!browserOffline && offlineCopyFrom !== null) void refetch();
  }, [browserOffline, offlineCopyFrom, refetch]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped when the database's rows or schema change: the row's activity is read again too.
  const [changes, setChanges] = useState(0);
  const onSignal = (event: string) => {
    if (event !== "rows" && event !== "schema") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void refetch();
      setChanges((n) => n + 1);
    }, 60);
  };
  useChannel(`db:${databaseId}`, onSignal);
  // Related rows appear by title, so their databases' changes matter too.
  useChannels(
    Object.values(data?.relations ?? {}).flatMap((r) =>
      r.database && r.database.id !== databaseId ? [`db:${r.database.id}`] : [],
    ),
    onSignal,
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const setValue = async (propertyId: string, value: unknown) => {
    const v = ++version.current;
    setPending((p) => ({ ...p, [propertyId]: { value, version: v } }));
    const res = await safe(updateRowPropertiesAction(rowId, { [propertyId]: value }));
    if (!res.ok) setError(res.error);
    else setError(null);
    await refetch();
    setChanges((n) => n + 1);
    setPending((p) => {
      if (p[propertyId]?.version !== v) return p;
      const next = { ...p };
      delete next[propertyId];
      return next;
    });
  };

  // A value of a row linked through a relation shown as a section, written to that row.
  const setRelatedValue = async (relatedId: string, propertyId: string, value: unknown) => {
    const res = await safe(updateRowPropertiesAction(relatedId, { [propertyId]: value }));
    if (!res.ok) setError(res.error);
    else setError(null);
    await refetch();
  };

  const createOption = async (propertyId: string, name: string): Promise<SelectOption | null> => {
    const res = await safe(ensureOptionAction(propertyId, name));
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    const option = res.data;
    setData((d) =>
      d && {
        ...d,
        properties: d.properties.map((p) =>
          p.id === propertyId && !(p.options.options ?? []).some((o) => o.id === option.id)
            ? { ...p, options: { ...p.options, options: [...(p.options.options ?? []), option] } }
            : p,
        ),
      },
    );
    return option;
  };

  const addProperty = async (name: string, type: PropertyType, relation?: RelationInput, derived?: DerivedInput) => {
    const res = await safe(addPropertyAction(databaseId, { name, type, relation, ...derived }));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  // Whether a property shows on row pages is the database's setting: shown here at once, then saved.
  const setPageVisibility = async (propertyId: string, visibility: PageVisibility) => {
    setData(
      (d) =>
        d && {
          ...d,
          properties: d.properties.map((p) => {
            if (p.id !== propertyId) return p;
            const { pageVisibility: _old, ...rest } = p.options;
            return { ...p, options: visibility === "show" ? rest : { ...rest, pageVisibility: visibility } };
          }),
        },
    );
    const res = await safe(updatePropertyAction(propertyId, { pageVisibility: visibility }));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  // What a property holds and how to fill it, the database's too: shown here at once, then saved.
  const setDescription = async (propertyId: string, description: string | null) => {
    setData(
      (d) =>
        d && {
          ...d,
          properties: d.properties.map((p) => {
            if (p.id !== propertyId) return p;
            const { description: _old, ...rest } = p.options;
            return { ...p, options: description ? { ...rest, description } : rest };
          }),
        },
    );
    const res = await safe(updatePropertyAction(propertyId, { description }));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  // Whether a URL property's links show a preview of the page, the database's too: shown here at once, then saved.
  const setUrlPreview = async (propertyId: string, on: boolean) => {
    setData(
      (d) =>
        d && {
          ...d,
          properties: d.properties.map((p) => {
            if (p.id !== propertyId) return p;
            const { url: _old, ...rest } = p.options;
            return { ...p, options: on ? { ...rest, url: { preview: true as const } } : rest };
          }),
        },
    );
    const res = await safe(updatePropertyAction(propertyId, { urlPreview: on }));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  // Row page layout, the database's for everyone (lib/row-layout): shown here at once, then saved.
  const setPinned = async (propertyId: string, pinned: boolean) => {
    setData(
      (d) =>
        d && {
          ...d,
          properties: d.properties.map((p) => {
            if (p.id !== propertyId) return p;
            const { pinned: _old, ...rest } = p.options;
            return { ...p, options: pinned ? { ...rest, pinned: true as const } : rest };
          }),
        },
    );
    const res = await safe(setPropertyPinnedAction(propertyId, pinned));
    if (!res.ok) setError(res.error);
    await refetch();
  };
  const switchBeside = async () => {
    const next = !data?.beside;
    setData((d) => d && { ...d, beside: next });
    const res = await safe(setPropertiesBesideAction(databaseId, next));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  const addAutofillProperty = async (name: string, config: AiAutofillConfig) => {
    const res = await safe(addAutofillPropertyAction(databaseId, name, config, [rowId]));
    if (!res.ok) setError(res.error);
    await refetch();
  };

  const refreshAutofill = useCallback(
    async (propertyId: string) => {
      setData((d) => d && { ...d, ai: d.ai && { ...d.ai, states: { ...d.ai.states, [propertyId]: { status: "pending" } } } });
      const res = await safe(refreshAutofillAction(propertyId, [rowId]));
      if (!res.ok) setError(res.error);
      await refetch();
    },
    [rowId, safe, refetch],
  );

  const createRelatedRow = useCallback(
    async (targetDatabaseId: string, title: string) => {
      const res = await safe(createRowAction(workspaceId, targetDatabaseId, { title }));
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      await refetch();
      return res.data.id;
    },
    [workspaceId, refetch, safe],
  );

  const relationContext = useMemo<RelationContextValue | null>(
    () =>
      data && {
        workspaceId,
        databaseId,
        databaseTitle: data.databaseTitle,
        targets: data.relations,
        createRow: createRelatedRow,
      },
    [data, workspaceId, databaseId, createRelatedRow],
  );
  const peopleContext = useMemo<PeopleContextValue>(
    () => ({ viewerId: data?.viewerId ?? null, people: data?.people ?? [] }),
    [data?.viewerId, data?.people],
  );
  const template = data?.template === true;
  const rowCell = useMemo(() => ({ rowId, template }), [rowId, template]);
  const aiEnabled = Boolean(data?.ai?.enabled) && !offline;
  const aiContext = useMemo<AiAutofillContextValue>(
    () => ({
      enabled: aiEnabled,
      states: { [rowId]: data?.ai?.states ?? {} },
      refresh: readOnly ? undefined : (propertyId) => void refreshAutofill(propertyId),
    }),
    [aiEnabled, rowId, data?.ai?.states, readOnly, refreshAutofill],
  );

  const accessContext = useMemo<PropertyAccessContextValue>(
    () => ({
      info: data?.propertyAccess ?? {},
      restricted: data?.restrictedPropertyIds ?? [],
      // Access is set from the database's column menus, not from a row.
      canManage: false,
    }),
    [data?.propertyAccess, data?.restrictedPropertyIds],
  );

  // Edited values show right away, with the row's formulas worked out again from them.
  const { values, styles } = useMemo(() => {
    if (!data) return { values: {}, styles: undefined };
    const edited = Object.entries(pending);
    if (!edited.length) return { values: data.values, styles: data.styles };
    const next = { ...data.values };
    for (const [id, p] of edited) next[id] = p.value;
    const [row] = withFormulas(
      data.properties,
      [{ title: data.title, properties: next, styles: data.styles }],
      { now: new Date(), people: data.people, relations: data.relations },
      relatedSchemasFrom(data.relations),
    );
    return { values: row.properties, styles: row.styles };
  }, [data, pending]);

  if (!data) {
    return error ? (
      <p className="mb-4 text-sm text-danger">{error}</p>
    ) : (
      <div className="mb-6 h-16 animate-pulse rounded-md bg-bg-subtle" aria-busy="true" />
    );
  }

  const valueOf = (id: string) => values[id];
  // A value the viewer may not see counts as one: its lock shows like any value.
  const { pinned, rest } = pinnedSplit(data.properties);
  const { shown: listed, more } = rowPageSections(rest, (p) => !data.hidden?.includes(p.id) && isEmptyValue(p, valueOf(p.id)));
  // Relations shown as a section of their own go under the list (a value the viewer may not see stays in it, locked).
  const isSection = (p: Property) => p.type === "relation" && p.options.relation?.display === "section" && !data.hidden?.includes(p.id);
  const shown = listed.filter((p) => !isSection(p));
  const sections = listed.filter(isSection);
  const canSetVisibility = !readOnly && !data.locked;
  const canSetLayout = canSetVisibility && Boolean(data.canSetLayout);
  const besideHere = data.beside && layoutHost?.aside ? layoutHost.aside : null;
  const propertyRow = (p: Property, variant: "row" | "pinned" | "beside" = besideHere ? "beside" : "row") => (
    <PropertyRow
      key={p.id}
      variant={variant}
      prop={p}
      rowId={rowId}
      row={data}
      value={valueOf(p.id)}
      style={styles?.[p.id]}
      readOnly={readOnly}
      onChange={(v) => void setValue(p.id, v)}
      onCreateOption={createOption}
      onPageVisibility={canSetVisibility ? (visibility) => void setPageVisibility(p.id, visibility) : undefined}
      onDescription={canSetVisibility ? (description) => void setDescription(p.id, description) : undefined}
      onUrlPreview={canSetVisibility && p.type === "url" ? (on) => void setUrlPreview(p.id, on) : undefined}
      onPinned={canSetLayout ? (on) => void setPinned(p.id, on) : undefined}
      pinFull={!canPin(data.properties, p.id)}
      values={values}
      commentable={!offline}
    />
  );

  const list = (
    <div className={cn("mb-6 border-b border-border pb-4", besideHere && "@3xl:mt-1 @3xl:mb-0 @3xl:border-b-0 @3xl:pb-0")}>
      {offline && <OfflineNotice savedAt={offlineCopyFrom} />}
      {!offline && <RowReviewBanner workspaceId={workspaceId} databaseId={databaseId} rowId={rowId} signal={changes} />}
      <div className="flex flex-col gap-0.5">
        {shown.map((p) => propertyRow(p))}
        {showMore && more.map((p) => propertyRow(p))}
      </div>
      {more.length > 0 && (
        <button
          type="button"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
          className="mt-1 flex h-[30px] w-fit items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {showMore ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
          {t(showMore ? "fewerProperties" : "moreProperties", { count: more.length })}
        </button>
      )}
      {!data.properties.length && readOnly && <p className="px-1 text-sm text-fg-faint">{t("noProperties")}</p>}
      {!readOnly && !data.locked && (
        <div className="flex flex-wrap items-center gap-x-2">
          <AddPropertyRow onCreate={addProperty} onCreateAutofill={aiEnabled ? addAutofillProperty : undefined} />
          {canSetLayout && (
            <button
              type="button"
              onClick={() => void switchBeside()}
              className="mt-1 inline-flex h-[30px] items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              {data.beside ? <PanelTop className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
              {t(data.beside ? "showAbove" : "showBeside")}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 px-1 text-xs text-danger">{error}</p>}
      {sections.length > 0 && (
        <div className="mt-4">
          {sections.map((p) => (
            <RelationSection
              key={p.id}
              prop={p}
              value={valueOf(p.id)}
              readOnly={readOnly || Boolean(data.readOnly?.includes(p.id))}
              onChange={(v) => void setValue(p.id, v)}
              onRelatedChange={(relatedId, propertyId, v) => void setRelatedValue(relatedId, propertyId, v)}
              onCreateOption={createOption}
            />
          ))}
        </div>
      )}
      {!offline && <RowEmails rowId={rowId} />}
      {!offline && <RowActivity rowId={rowId} signal={changes} />}
    </div>
  );

  return (
    <RowCellProvider value={rowCell}>
      <RelationProvider value={relationContext}>
        <PeopleProvider value={peopleContext}>
          <SchemaProvider value={data.properties}>
            <PropertyAccessProvider value={accessContext}>
              <AiAutofillProvider value={aiContext}>
                {pinned.length > 0 && (
                  <div role="group" aria-label={t("pinned")} className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
                    {pinned.map((p) => propertyRow(p, "pinned"))}
                  </div>
                )}
                {besideHere ? createPortal(list, besideHere) : list}
              </AiAutofillProvider>
            </PropertyAccessProvider>
          </SchemaProvider>
        </PeopleProvider>
      </RelationProvider>
    </RowCellProvider>
  );
}

/** One property of the row: its name, then its value (a lock when the viewer may not see it). */
function PropertyRow({
  prop: p,
  rowId,
  row,
  value,
  style,
  readOnly,
  onChange,
  onCreateOption,
  onPageVisibility,
  onDescription,
  onUrlPreview,
  onPinned,
  pinFull,
  values,
  commentable,
  variant,
}: {
  /** A line of the list ("beside": in the column beside the body, its name above its value where that is narrow), or one of the pinned values under the title. */
  variant: "row" | "pinned" | "beside";
  prop: Property;
  rowId: string;
  row: { hidden?: string[]; readOnly?: string[] };
  value: unknown;
  style?: FormulaStyle;
  readOnly: boolean;
  onChange: (value: unknown) => void;
  onCreateOption: (propertyId: string, name: string) => Promise<SelectOption | null>;
  /** People who may change the database's properties: whether this one shows on row pages. */
  onPageVisibility?: (visibility: PageVisibility) => void;
  /** The same people: what the property holds and how to fill it (null for nothing). */
  onDescription?: (description: string | null) => void;
  /** The same people, for URL properties: whether row pages show a preview of the linked page. */
  onUrlPreview?: (on: boolean) => void;
  /** Full access: pins the property under the title, or unpins it; `pinFull` while no more fit. */
  onPinned?: (pinned: boolean) => void;
  pinFull: boolean;
  /** The row's values, which decide the options a dependent select offers (lib/dependent-options). */
  values: Record<string, unknown>;
  /** The value can be discussed in the row's comments (they need the server). */
  commentable: boolean;
}) {
  const t = useTranslations("database.rowProperties");
  const access = usePropertyAccess();
  const valueAccess = access.valueAccess(row, p.id);
  const fixed = readOnly || valueAccess === "readOnly";
  const menu = useFloating<HTMLButtonElement>();
  const [labelEl, setLabelEl] = useState<HTMLDivElement | null>(null);
  const { hint, description } = usePropertyHint(p, labelEl, menu.open);
  const label = (
    <>
      <PropertyTypeIcon type={p.type} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate" title={description ? undefined : p.name} aria-description={description || undefined}>
        {p.name}
      </span>
    </>
  );
  const stacked = variant === "pinned";
  return (
    <div
      className={cn(
        "group/property flex min-h-[30px]",
        stacked ? "max-w-full min-w-32 flex-col" : "items-start gap-2",
        variant === "beside" && "@3xl:flex-col @3xl:items-stretch @3xl:gap-0",
      )}
    >
      <div
        ref={setLabelEl}
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-fg-muted",
          stacked ? "h-6 text-xs" : "h-[30px] w-28 text-sm sm:w-40",
          variant === "beside" && "@3xl:h-6 @3xl:w-full @3xl:text-xs",
        )}
      >
        {hint}
        {onPageVisibility && access.canEditSchema(p.id) ? (
          <>
            <button
              ref={menu.ref}
              type="button"
              aria-label={t("propertyMenu", { name: p.name })}
              aria-expanded={menu.open}
              onClick={menu.toggle}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-md px-1 hover:bg-bg-hover hover:text-fg"
            >
              {label}
            </button>
            <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
              <PropertyMenu
                prop={p}
                actions={{ setPageVisibility: onPageVisibility, setDescription: onDescription, setUrlPreview: onUrlPreview, setPinned: onPinned, pinFull }}
                onDone={menu.close}
              />
            </Floating>
          </>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 px-1">{label}</span>
        )}
        <PropertyLock propertyId={p.id} />
        {/* Pinned and beside the body, the value may sit under its name: the comments go with the name. */}
        {commentable && variant !== "row" && valueAccess !== "hidden" && <PropertyComments rowId={rowId} prop={p} compact />}
      </div>
      <div className="min-w-0 flex-1">
        {valueAccess === "hidden" ? (
          <PropertyCell variant="panel" prop={p} value={undefined} hidden onChange={onChange} onCreateOption={onCreateOption} />
        ) : (
          <AiCell prop={p} rowId={rowId} readOnly={fixed}>
            <PropertyCell
              variant="panel"
              wrap
              prop={p}
              value={value}
              style={style}
              readOnly={fixed}
              onChange={onChange}
              onCreateOption={onCreateOption}
              rowValues={values}
              upload={p.type === "files" ? uploadToPage(rowId) : undefined}
            />
          </AiCell>
        )}
        {p.type === "url" && p.options.url?.preview && variant !== "pinned" && valueAccess !== "hidden" && typeof value === "string" && /^https?:\/\//i.test(value) && (
          <UrlPreview rowId={rowId} propertyId={p.id} url={value} />
        )}
      </div>
      {commentable && variant === "row" && valueAccess !== "hidden" && <PropertyComments rowId={rowId} prop={p} />}
    </div>
  );
}

/**
 * The comments on a property's value: how many open threads it has, and a button (shown on hover
 * while it has none) that opens the row's comments to start one (server/property-comments.ts).
 */
function PropertyComments({ rowId, prop, compact = false }: { rowId: string; prop: Property; compact?: boolean }) {
  const t = useTranslations("database.rowProperties");
  const count = usePropertyThreadCount(rowId, prop.id);
  return (
    <button
      type="button"
      aria-label={count ? t("propertyComments", { name: prop.name, count }) : t("commentOnProperty", { name: prop.name })}
      title={count ? t("propertyComments", { name: prop.name, count }) : t("commentOnProperty", { name: prop.name })}
      onClick={() => requestPropertyComment(rowId, { propertyId: prop.id, name: prop.name })}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg",
        compact ? "h-6" : "h-[30px]",
        !count && "opacity-0 focus-visible:opacity-100 group-hover/property:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {count > 0 && <span>{count}</span>}
    </button>
  );
}

function AddPropertyRow({
  onCreate,
  onCreateAutofill,
}: {
  onCreate: (name: string, type: PropertyType, relation?: RelationInput, derived?: DerivedInput) => Promise<void>;
  onCreateAutofill?: (name: string, config: AiAutofillConfig) => Promise<void>;
}) {
  const t = useTranslations("database.rowProperties");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        onClick={menu.toggle}
        className="mt-1 inline-flex h-[30px] items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("addProperty")}
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
        <AddPropertyPanel onCreate={onCreate} onCreateAutofill={onCreateAutofill} onDone={menu.close} />
      </Floating>
    </>
  );
}

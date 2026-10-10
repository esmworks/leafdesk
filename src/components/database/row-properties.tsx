"use client";

import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addPropertyAction,
  createRowAction,
  ensureOptionAction,
  loadRowAction,
  updatePropertyAction,
  updateRowPropertiesAction,
} from "@/app/actions/databases";
import { addAutofillPropertyAction, refreshAutofillAction } from "@/app/actions/ai";
import { useChannel, useChannels } from "@/components/collab/use-channel";
import { useIsOffline, useOffline } from "@/components/offline/offline-context";
import { OfflineNotice } from "@/components/offline/offline-notice";
import { deleteSnapshot, loadSnapshot, rowSnapshotKey, saveSnapshot } from "@/components/offline/offline-store";
import type { AiAutofillConfig, AiCellState } from "@/lib/ai";
import type { PropertyAccessInfo } from "@/lib/property-access";
import { relatedSchemasFrom, withFormulas } from "@/lib/derived";
import type { FormulaStyle } from "@/lib/formula";
import { rowPageSections, type PageVisibility } from "@/lib/page-visibility";
import type { PropertyType, SelectOption } from "@/db/schema/app";
import { AiAutofillProvider, AiCell, type AiAutofillContextValue } from "./ai-autofill";
import { Floating, useFloating } from "./floating";
import { PeopleProvider, type PeopleContextValue } from "./person-cell";
import { uploadToPage } from "./files-cell";
import { PropertyAccessProvider, PropertyLock, usePropertyAccess, type PropertyAccessContextValue } from "./property-access";
import { isEmptyValue, PropertyCell } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import { AddPropertyPanel, PropertyMenu } from "./property-menu";
import { RelationProvider, type RelationContextValue } from "./relation-context";
import { SchemaProvider } from "./schema-context";
import type { DerivedInput, PersonRef, Property, RelationInput, RelationTarget } from "./types";

type Loaded = {
  databaseTitle: string;
  /** The row's title, which formulas can read. */
  title: string;
  /** The database's schema is locked: no new properties from here. */
  locked: boolean;
  properties: Property[];
  values: Record<string, unknown>;
  relations: Record<string, RelationTarget>;
  people: PersonRef[];
  viewerId: string;
  /** AI autofill: whether AI is available, and this row's pending and failed values. */
  ai?: { enabled: boolean; states: Record<string, AiCellState> };
  /** Property access: values of this row left out for the viewer, and ones they can't change. */
  hidden?: string[];
  readOnly?: string[];
  /** How styled formula results show. */
  styles?: Record<string, FormulaStyle>;
  /** The viewer's level on each restricted property. */
  propertyAccess?: Record<string, PropertyAccessInfo>;
  /** With full access: the properties that have access rules. */
  restrictedPropertyIds?: string[];
};

/** Editable property list shown above a database row's page body. */
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
      const loaded: Loaded = {
        databaseTitle: res.data.databaseTitle,
        title: res.data.row.title,
        locked: res.data.databaseLocked,
        properties: res.data.properties,
        values: res.data.row.properties,
        relations: res.data.relations,
        people: res.data.people,
        viewerId: res.data.viewerId,
        ai: res.data.ai,
        hidden: res.data.row.hidden,
        readOnly: res.data.row.readOnly,
        styles: res.data.row.styles,
        propertyAccess: res.data.propertyAccess,
        restrictedPropertyIds: res.data.restrictedPropertyIds,
      };
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
  const onSignal = (event: string) => {
    if (event !== "rows" && event !== "schema") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refetch(), 60);
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
    setPending((p) => {
      if (p[propertyId]?.version !== v) return p;
      const next = { ...p };
      delete next[propertyId];
      return next;
    });
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
  const { shown, more } = rowPageSections(data.properties, (p) => !data.hidden?.includes(p.id) && isEmptyValue(p, valueOf(p.id)));
  const canSetVisibility = !readOnly && !data.locked;
  const propertyRow = (p: Property) => (
    <PropertyRow
      key={p.id}
      prop={p}
      rowId={rowId}
      row={data}
      value={valueOf(p.id)}
      style={styles?.[p.id]}
      readOnly={readOnly}
      onChange={(v) => void setValue(p.id, v)}
      onCreateOption={createOption}
      onPageVisibility={canSetVisibility ? (visibility) => void setPageVisibility(p.id, visibility) : undefined}
    />
  );

  return (
    <RelationProvider value={relationContext}>
      <PeopleProvider value={peopleContext}>
        <SchemaProvider value={data.properties}>
          <PropertyAccessProvider value={accessContext}>
            <AiAutofillProvider value={aiContext}>
              <div className="mb-6 border-b border-border pb-4">
                {offline && <OfflineNotice savedAt={offlineCopyFrom} />}
                <div className="flex flex-col gap-0.5">
                  {shown.map(propertyRow)}
                  {showMore && more.map(propertyRow)}
                </div>
                {more.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={showMore}
                    onClick={() => setShowMore((v) => !v)}
                    className="mt-1 flex h-[30px] w-fit items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                  >
                    {showMore ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {t(showMore ? "fewerProperties" : "moreProperties", { count: more.length })}
                  </button>
                )}
                {!data.properties.length && readOnly && <p className="px-1 text-sm text-fg-faint">{t("noProperties")}</p>}
                {!readOnly && !data.locked && (
                  <AddPropertyRow onCreate={addProperty} onCreateAutofill={aiEnabled ? addAutofillProperty : undefined} />
                )}
                {error && <p className="mt-2 px-1 text-xs text-danger">{error}</p>}
              </div>
            </AiAutofillProvider>
          </PropertyAccessProvider>
        </SchemaProvider>
      </PeopleProvider>
    </RelationProvider>
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
}: {
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
}) {
  const t = useTranslations("database.rowProperties");
  const access = usePropertyAccess();
  const valueAccess = access.valueAccess(row, p.id);
  const fixed = readOnly || valueAccess === "readOnly";
  const menu = useFloating<HTMLButtonElement>();
  const label = (
    <>
      <PropertyTypeIcon type={p.type} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate" title={p.name}>
        {p.name}
      </span>
    </>
  );
  return (
    <div className="flex min-h-[30px] items-start gap-2">
      <div className="flex h-[30px] w-28 shrink-0 items-center gap-1.5 text-sm text-fg-muted sm:w-40">
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
              <PropertyMenu prop={p} actions={{ setPageVisibility: onPageVisibility }} onDone={menu.close} />
            </Floating>
          </>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 px-1">{label}</span>
        )}
        <PropertyLock propertyId={p.id} />
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
              upload={p.type === "files" ? uploadToPage(rowId) : undefined}
            />
          </AiCell>
        )}
      </div>
    </div>
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

"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addPropertyAction,
  setSubItemsAction,
  setDependenciesAction,
  addViewAction,
  archiveRowsAction,
  changePropertyTypeAction,
  createRowAction,
  deletePropertyAction,
  duplicatePropertyAction,
  deleteViewAction,
  duplicateRowsAction,
  ensureOptionAction,
  loadDatabaseAction,
  moveRowAction,
  moveViewAction,
  updatePropertyAction,
  renameRowAction,
  updateRowPropertiesAction,
  updateRowsPropertiesAction,
  updateViewAction,
  type ActionResult,
} from "@/app/actions/databases";
import { addAutofillPropertyAction, refreshAutofillAction, setAutofillAction } from "@/app/actions/ai";
import { archivePageAction } from "@/app/actions/pages";
import { useChannel, useChannels } from "@/components/collab/use-channel";
import { useIsOffline, useOffline } from "@/components/offline/offline-context";
import { databaseSnapshotKey, deleteSnapshot, loadSnapshot, saveSnapshot } from "@/components/offline/offline-store";
import type { NumberFormat, PropertyType, SelectOption, ViewConfig, ViewType } from "@/db/schema/app";
import { MAX_AUTOFILL_ROWS, type AiAutofillConfig } from "@/lib/ai";
import { checkDateOptions, type DateOptionsInput } from "@/lib/date-options";
import type { DependencyInput } from "@/lib/dependencies";
import { compileFormulas, evaluateFormulas } from "@/lib/derived";
import { moveGroupValue } from "@/lib/grouping";
import type { RollupConfig } from "@/db/schema/app";
import type { DatabaseSnapshot, DerivedInput, Property, RelationInput, RollupInput, Row, View } from "./types";
import { TITLE } from "./types";

type Pending = { rowId: string; key: string; value: unknown; version: number };

/** A failed database action; its message is already translated on the server. */
class ActionError extends Error {}

async function unwrap<T>(p: Promise<ActionResult<T>>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new ActionError(res.error);
  return res.data;
}

/**
 * Client state for one database: server snapshot + optimistic overlays, kept fresh through the
 * `db:<id>` signal channel. Cell edits are layered as pending overlays until the server confirms,
 * so a refetch that races an in-flight write never flashes the old value.
 */
export function useDatabase(
  databaseId: string,
  /** `covers`: load gallery covers for a gallery the database itself doesn't have (a linked view). */
  { covers = false }: { covers?: boolean } = {},
) {
  const tc = useTranslations("common");
  const tb = useTranslations("database.bulk");
  const ta = useTranslations("ai.autofill");
  const genericError = tc("genericError");
  // Other failures (thrown page actions, network errors) carry untranslated text, so they get
  // the generic message instead.
  const message = useCallback(
    (error: unknown) => (error instanceof ActionError ? error.message : genericError),
    [genericError],
  );
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // When the rows on screen are the copy kept in this browser (the server couldn't be reached):
  // when that copy was saved. Such a copy is read-only.
  const [offlineCopyFrom, setOfflineCopyFrom] = useState<number | null>(null);
  const offlineUser = useOffline()?.userId;
  const snapshotKey = databaseSnapshotKey(databaseId, covers);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const seq = useRef(0);
  const version = useRef(0);

  const refetch = useCallback(async () => {
    const mine = ++seq.current;
    let unreachable = false;
    const res = await loadDatabaseAction(databaseId, { covers }).catch((e: unknown) => {
      unreachable = true;
      return { ok: false as const, error: message(e) };
    });
    if (mine !== seq.current) return;
    if (!res.ok) {
      // Offline: show the rows from the last visit, if this browser kept them.
      const kept = unreachable && offlineUser ? await loadSnapshot<DatabaseSnapshot>(offlineUser, snapshotKey) : null;
      if (mine !== seq.current) return;
      if (kept) {
        setLoadError(null);
        setOfflineCopyFrom(kept.savedAt);
        setSnapshot(kept.data);
        return;
      }
      // The server answered no (e.g. access was taken away): its copy here goes too.
      if (!unreachable && offlineUser) void deleteSnapshot(offlineUser, snapshotKey);
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setOfflineCopyFrom(null);
    setSnapshot(res.data);
    if (offlineUser) void saveSnapshot(offlineUser, snapshotKey, res.data);
  }, [databaseId, covers, message, offlineUser, snapshotKey]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(`db:${databaseId}`, (event) => {
    if (event !== "rows" && event !== "schema") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refetch(), 60);
  });
  // Titles and rows of related databases show up in relation cells.
  const relatedChannels = useMemo(
    () =>
      Object.values(snapshot?.relations ?? {}).flatMap((r) =>
        r.database && r.database.id !== databaseId ? [`db:${r.database.id}`] : [],
      ),
    [snapshot?.relations, databaseId],
  );
  useChannels(relatedChannels, (event) => {
    if (event !== "rows" && event !== "schema") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refetch(), 60);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const report = useCallback((e: unknown) => setError(message(e)), [message]);

  // Formulas of a row the user just edited are worked out here right away, with the same code the
  // server uses, so the row doesn't show stale results until the refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompiled only when the properties change, not the rows
  const formulas = useMemo(() => (snapshot ? compileFormulas(snapshot.properties) : new Map()), [snapshot?.properties]);
  const rows: Row[] = useMemo(() => {
    if (!snapshot) return [];
    const overlays = Object.values(pending);
    const context = { now: new Date(), people: snapshot.people, relations: snapshot.relations };
    return snapshot.rows
      .filter((r) => !removed.has(r.id))
      .map((row) => {
        const mine = overlays.filter((p) => p.rowId === row.id);
        if (!mine.length) return row;
        const next = { ...row, properties: { ...row.properties } };
        for (const p of mine) {
          if (p.key === TITLE) next.title = String(p.value ?? "");
          else if (p.value === null || p.value === undefined) delete next.properties[p.key];
          else next.properties[p.key] = p.value;
        }
        if (formulas.size) Object.assign(next.properties, evaluateFormulas(snapshot.properties, formulas, next, context));
        return next;
      });
  }, [snapshot, pending, removed, formulas]);

  const withPending = useCallback(
    async (rowId: string, key: string, value: unknown, write: () => Promise<unknown>) => {
      const token = `${rowId}\u0000${key}`;
      const v = ++version.current;
      setPending((p) => ({ ...p, [token]: { rowId, key, value, version: v } }));
      try {
        await write();
        await refetch();
      } catch (e) {
        report(e);
      } finally {
        setPending((p) => {
          if (p[token]?.version !== v) return p;
          const next = { ...p };
          delete next[token];
          return next;
        });
      }
    },
    [refetch, report],
  );

  const setCell = useCallback(
    (rowId: string, key: string, value: unknown) =>
      withPending(rowId, key, value, async () => {
        if (key === TITLE) await unwrap(renameRowAction(rowId, String(value ?? "")));
        else await unwrap(updateRowPropertiesAction(rowId, { [key]: value }));
      }),
    [withPending],
  );

  /**
   * Sets several properties of one row (a timeline bar's start and end), the title too under TITLE
   * (a new row named with quick add), and refetches once: the row shows the new values right away
   * and keeps them until the server confirms.
   */
  const setRowValues = useCallback(
    async (rowId: string, values: Record<string, unknown>) => {
      const keys = Object.keys(values);
      if (!keys.length) return;
      const v = ++version.current;
      const tokens = keys.map((key) => `${rowId}\u0000${key}`);
      setPending((p) => {
        const next = { ...p };
        for (const key of keys) next[`${rowId}\u0000${key}`] = { rowId, key, value: values[key], version: v };
        return next;
      });
      try {
        const { [TITLE]: title, ...properties } = values;
        await Promise.all([
          TITLE in values ? unwrap(renameRowAction(rowId, String(title ?? ""))) : null,
          Object.keys(properties).length ? unwrap(updateRowPropertiesAction(rowId, properties)) : null,
        ]);
        await refetch();
      } catch (e) {
        report(e);
      } finally {
        setPending((p) => {
          const next = { ...p };
          for (const token of tokens) if (next[token]?.version === v) delete next[token];
          return next;
        });
      }
    },
    [refetch, report],
  );

  /**
   * Sets one property on several rows (bulk edit): every row shows the new value right away, and
   * rows the server skipped (see databases.rowsWithAccess) are reported, then refetched back.
   */
  const setCells = useCallback(
    async (rowIds: string[], key: string, value: unknown) => {
      const v = ++version.current;
      const tokens = rowIds.map((rowId) => `${rowId}\u0000${key}`);
      setPending((p) => {
        const next = { ...p };
        for (const rowId of rowIds) next[`${rowId}\u0000${key}`] = { rowId, key, value, version: v };
        return next;
      });
      try {
        const result = await unwrap(updateRowsPropertiesAction(databaseId, rowIds, { [key]: value }));
        if (result.skipped.length) setError(tb("skipped", { count: result.skipped.length }));
        await refetch();
      } catch (e) {
        report(e);
      } finally {
        setPending((p) => {
          const next = { ...p };
          for (const token of tokens) if (next[token]?.version === v) delete next[token];
          return next;
        });
      }
    },
    [databaseId, refetch, report, tb],
  );

  /** Applies a local schema change immediately, then persists it and refetches. */
  const mutateSchema = useCallback(
    async <T,>(local: (s: DatabaseSnapshot) => DatabaseSnapshot, write: () => Promise<ActionResult<T>>) => {
      setSnapshot((s) => (s ? local(s) : s));
      try {
        const data = await unwrap(write());
        return data;
      } catch (e) {
        report(e);
        return null;
      } finally {
        await refetch();
      }
    },
    [refetch, report],
  );

  const patchProperty = (id: string, patch: Partial<Property>) => (s: DatabaseSnapshot) => ({
    ...s,
    properties: s.properties.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });

  const api = useMemo(
    () => ({
      refetch,
      setCell,
      setRowValues,
      setCells,
      clearError: () => setError(null),
      /** Shows an already translated message in the error banner. */
      showError: (message: string) => setError(message),
      report,

      /**
       * Adds a row: blank, from a row template (templateId), or from the database's default
       * template when it has one (useDefault, what "New" does). Returns its id.
       */
      async createRow(
        input: { title?: string; properties?: Record<string, unknown>; templateId?: string | null; useDefault?: boolean } = {},
      ) {
        if (!snapshot) return null;
        try {
          const created = await unwrap(createRowAction(snapshot.database.workspaceId, databaseId, input));
          await refetch();
          return created.id;
        } catch (e) {
          report(e);
          return null;
        }
      },

      async deleteRow(rowId: string) {
        setRemoved((s) => new Set(s).add(rowId));
        try {
          await archivePageAction(rowId);
          await refetch();
        } catch (e) {
          report(e);
        } finally {
          setRemoved((s) => {
            const next = new Set(s);
            next.delete(rowId);
            return next;
          });
        }
      },

      /** Moves rows to the trash; they disappear right away and come back if the server refuses. */
      async deleteRows(rowIds: string[]) {
        setRemoved((s) => new Set([...s, ...rowIds]));
        try {
          const result = await unwrap(archiveRowsAction(databaseId, rowIds));
          if (result.skipped.length) setError(tb("skipped", { count: result.skipped.length }));
          await refetch();
        } catch (e) {
          report(e);
        } finally {
          setRemoved((s) => new Set([...s].filter((id) => !rowIds.includes(id))));
        }
      },

      async duplicateRows(rowIds: string[]) {
        try {
          const result = await unwrap(duplicateRowsAction(databaseId, rowIds));
          if (result.skipped.length) setError(tb("skipped", { count: result.skipped.length }));
        } catch (e) {
          report(e);
        } finally {
          await refetch();
        }
      },

      moveRow(
        rowId: string,
        move: { position?: number; groupBy?: string; groupValue?: string | null; groupFrom?: string | null },
      ) {
        setSnapshot((s) =>
          s
            ? {
                ...s,
                rows: s.rows.map((r) => {
                  if (r.id !== rowId) return r;
                  const properties = { ...r.properties };
                  const prop = move.groupBy ? s.properties.find((p) => p.id === move.groupBy) : undefined;
                  if (prop) {
                    const value = moveGroupValue(prop, properties[prop.id], move.groupFrom, move.groupValue);
                    if (value === null || (Array.isArray(value) && !value.length)) delete properties[prop.id];
                    else properties[prop.id] = value;
                  }
                  return { ...r, properties, position: move.position ?? r.position };
                }).sort((a, b) => a.position - b.position),
              }
            : s,
        );
        return mutateSchema((s) => s, () => moveRowAction(rowId, move));
      },

      addProperty(name: string, type: PropertyType, options?: string[], relation?: RelationInput, derived?: DerivedInput) {
        return mutateSchema((s) => s, () => addPropertyAction(databaseId, { name, type, options, relation, ...derived }));
      },

      /** Turns sub-items on (new properties, or the relation `propertyId`) or off. */
      setSubItems(on: boolean, propertyId?: string) {
        return mutateSchema((s) => s, () => setSubItemsAction(databaseId, { on, propertyId }));
      },

      /** Turns dependencies on (new properties, or the relation `propertyId`) or off, or changes their settings. */
      setDependencies(on: boolean, input: { propertyId?: string; settings?: DependencyInput } = {}) {
        return mutateSchema((s) => s, () => setDependenciesAction(databaseId, { on, ...input }));
      },

      /** Saves a formula's expression (with property ids); the server checks it again. */
      setFormula(prop: Property, expression: string) {
        return mutateSchema(
          patchProperty(prop.id, { options: { ...prop.options, formula: { ...prop.options.formula, expression } } }),
          () => updatePropertyAction(prop.id, { formula: { expression } }),
        );
      },

      /** Saves a rollup's settings; the server checks them and works out the values again. */
      setRollup(prop: Property, rollup: RollupInput) {
        const { display, ...rest } = rollup;
        const options = { ...prop.options, rollup: { ...rest, ...(display ? { display } : {}) } as RollupConfig };
        return mutateSchema(patchProperty(prop.id, { options }), () => updatePropertyAction(prop.id, { rollup }));
      },

      /** Saves how a number property shows its values (null for plain numbers); the server checks it. */
      setNumberFormat(prop: Property, number: NumberFormat | null) {
        const { number: _old, ...rest } = prop.options;
        return mutateSchema(patchProperty(prop.id, { options: number ? { ...rest, number } : rest }), () =>
          updatePropertyAction(prop.id, { number }),
        );
      },

      /** Saves a date property's display and reminder (see lib/date-options); the server checks it. */
      setDateOptions(prop: Property, input: DateOptionsInput) {
        const checked = checkDateOptions(input, prop.options.date, new Date());
        if (!checked.ok) return;
        const { date: _old, ...rest } = prop.options;
        return mutateSchema(patchProperty(prop.id, { options: checked.options ? { ...rest, date: checked.options } : rest }), () =>
          updatePropertyAction(prop.id, { date: input }),
        );
      },

      /** Adds a row to another (related) database; returns its id. */
      async createRelatedRow(targetDatabaseId: string, title: string) {
        if (!snapshot) return null;
        try {
          const created = await unwrap(createRowAction(snapshot.database.workspaceId, targetDatabaseId, { title }));
          await refetch();
          return created.id;
        } catch (e) {
          report(e);
          return null;
        }
      },

      renameProperty(id: string, name: string) {
        return mutateSchema(patchProperty(id, { name }), () => updatePropertyAction(id, { name }));
      },

      setOptions(prop: Property, options: SelectOption[]) {
        return mutateSchema(patchProperty(prop.id, { options: { ...prop.options, options } }), () =>
          updatePropertyAction(prop.id, { options }),
        );
      },

      async createOption(propertyId: string, name: string): Promise<SelectOption | null> {
        try {
          const option = await unwrap(ensureOptionAction(propertyId, name));
          setSnapshot((s) =>
            s
              ? {
                  ...s,
                  properties: s.properties.map((p) => {
                    if (p.id !== propertyId) return p;
                    const options = p.options.options ?? [];
                    if (options.some((o) => o.id === option.id)) return p;
                    return { ...p, options: { ...p.options, options: [...options, option] } };
                  }),
                }
              : s,
          );
          return option;
        } catch (e) {
          report(e);
          return null;
        }
      },

      /** Copies a property with its values right after it; returns the copy. */
      duplicateProperty(id: string, name: string) {
        return mutateSchema((s) => s, () => duplicatePropertyAction(id, name));
      },

      /** Changes a property's type; the server converts the values and the snapshot reloads. */
      changePropertyType(id: string, change: Parameters<typeof changePropertyTypeAction>[1]) {
        return mutateSchema((s) => s, () => changePropertyTypeAction(id, change));
      },

      deleteProperty(id: string) {
        return mutateSchema(
          (s) => ({ ...s, properties: s.properties.filter((p) => p.id !== id) }),
          () => deletePropertyAction(id),
        );
      },

      addView(name: string, type: ViewType) {
        return mutateSchema((s) => s, () => addViewAction(databaseId, { name, type }));
      },

      updateView(view: View, patch: { name?: string; config?: ViewConfig }) {
        return mutateSchema(
          (s) => ({
            ...s,
            views: s.views.map((v) =>
              v.id === view.id ? { ...v, ...(patch.name ? { name: patch.name } : {}), ...(patch.config ? { config: patch.config } : {}) } : v,
            ),
          }),
          () => updateViewAction(view.id, patch),
        );
      },

      /** Moves a view's tab before or after another one. */
      moveView(viewId: string, targetId: string, side: "before" | "after") {
        return mutateSchema(
          (s) => {
            const moved = s.views.find((v) => v.id === viewId);
            const rest = s.views.filter((v) => v.id !== viewId);
            const at = rest.findIndex((v) => v.id === targetId);
            if (!moved || at < 0) return s;
            rest.splice(side === "before" ? at : at + 1, 0, moved);
            return { ...s, views: rest.map((v, i) => ({ ...v, position: i + 1 })) };
          },
          () => moveViewAction(viewId, targetId, side),
        );
      },

      deleteView(viewId: string) {
        return mutateSchema(
          (s) => ({ ...s, views: s.views.filter((v) => v.id !== viewId) }),
          () => deleteViewAction(viewId),
        );
      },

      /** Turns AI autofill on, changes it, or (null) turns it off for a text property. */
      setAutofill(prop: Property, config: AiAutofillConfig | null) {
        const options = { ...prop.options };
        if (config) options.ai = config;
        else delete options.ai;
        return mutateSchema(patchProperty(prop.id, { options }), () => setAutofillAction(prop.id, config));
      },

      /** Adds a text property that AI fills in, and fills it in for `rowIds` (the view's rows). */
      addAutofillProperty(name: string, config: AiAutofillConfig, rowIds: string[]) {
        if (rowIds.length > MAX_AUTOFILL_ROWS) setError(ta("tooManyRows", { max: MAX_AUTOFILL_ROWS }));
        return mutateSchema((s) => s, () => addAutofillPropertyAction(databaseId, name, config, rowIds.slice(0, MAX_AUTOFILL_ROWS)));
      },

      /** Works the AI values of these rows out again (one row's refresh, or all rows of a view). */
      async refreshAutofill(propertyId: string, rowIds: string[]) {
        if (rowIds.length > MAX_AUTOFILL_ROWS) setError(ta("tooManyRows", { max: MAX_AUTOFILL_ROWS }));
        const ids = rowIds.slice(0, MAX_AUTOFILL_ROWS);
        // Pending right away; the refetch after the server queued them confirms it.
        setSnapshot((s) => {
          if (!s?.ai) return s;
          const states = { ...s.ai.states };
          for (const id of ids) states[id] = { ...states[id], [propertyId]: { status: "pending" } };
          return { ...s, ai: { ...s.ai, states } };
        });
        try {
          const result = await unwrap(refreshAutofillAction(propertyId, ids));
          if (result.skipped) setError(tb("skipped", { count: result.skipped }));
        } catch (e) {
          report(e);
        } finally {
          await refetch();
        }
      },
    }),
    // patchProperty is a pure helper; the rest are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the workspace id of the snapshot is read
    [databaseId, snapshot?.database.workspaceId, refetch, setCell, setRowValues, setCells, mutateSchema, report, tb, ta],
  );

  // Back online: replace the offline copy with the server's rows.
  const offline = useIsOffline();
  useEffect(() => {
    if (!offline && offlineCopyFrom !== null) void refetch();
  }, [offline, offlineCopyFrom, refetch]);

  return { snapshot, rows, loadError, error, api, offlineCopyFrom };
}

export type DatabaseApi = ReturnType<typeof useDatabase>["api"];

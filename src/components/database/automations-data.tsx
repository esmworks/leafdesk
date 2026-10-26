"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listDatabasesAction, loadDatabaseAction } from "@/app/actions/databases";
import type { PersonRef, Property, RelationTarget } from "./types";

/**
 * The databases the automations dialog works with: the workspace's list (for steps that find,
 * add or change rows elsewhere) and, loaded once each while the dialog is open, a database's
 * properties, relation targets, people and row titles (for values, filters and test runs).
 */

export type DatabaseRef = { id: string; title: string; icon: string | null };

export type DatabaseInfo = {
  id: string;
  title: string;
  properties: Property[];
  relations: Record<string, RelationTarget>;
  people: PersonRef[];
  viewerId: string;
  rows: { id: string; title: string }[];
  /** Its shared views (personal ones can't start an automation): a threshold's choice. */
  views: { id: string; name: string; type: string }[];
  /** Row templates a step that adds a row can start from, and the database's default one. */
  templates: { id: string; title: string; icon: string | null }[];
  defaultTemplateId: string | null;
};

type DatabasesValue = {
  workspaceId: string;
  list: DatabaseRef[] | null;
  /** Loaded databases by id; null for one that couldn't be. */
  infos: Record<string, DatabaseInfo | null>;
  load: (id: string) => void;
  /** Loads it again (its rows changed). */
  reload: (id: string) => void;
};

const DatabasesContext = createContext<DatabasesValue | null>(null);

export function DatabasesProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [list, setList] = useState<DatabaseRef[] | null>(null);
  const [infos, setInfos] = useState<Record<string, DatabaseInfo | null>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    listDatabasesAction(workspaceId)
      .then((res) => live && setList(res.ok ? res.data : []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const fetchInfo = useCallback((id: string) => {
    loadDatabaseAction(id)
      .then((res) =>
        setInfos((all) => ({
          ...all,
          [id]: res.ok
            ? {
                id,
                title: res.data.database.title,
                properties: res.data.properties,
                relations: res.data.relations,
                people: res.data.people,
                viewerId: res.data.viewerId,
                rows: res.data.rows.map((r) => ({ id: r.id, title: r.title })),
                views: res.data.views.filter((v) => v.ownerId === null).map((v) => ({ id: v.id, name: v.name, type: v.type })),
                templates: res.data.templates.map((r) => ({ id: r.id, title: r.title, icon: r.icon })),
                defaultTemplateId: res.data.database.defaultTemplateId,
              }
            : null,
        })),
      )
      .catch(() => setInfos((all) => ({ ...all, [id]: null })));
  }, []);

  const load = useCallback(
    (id: string) => {
      if (!id || asked.current.has(id)) return;
      asked.current.add(id);
      fetchInfo(id);
    },
    [fetchInfo],
  );

  const value = useMemo(() => ({ workspaceId, list, infos, load, reload: fetchInfo }), [workspaceId, list, infos, load, fetchInfo]);
  return <DatabasesContext.Provider value={value}>{children}</DatabasesContext.Provider>;
}

function useDatabases() {
  const ctx = useContext(DatabasesContext);
  if (!ctx) throw new Error("useDatabases outside DatabasesProvider");
  return ctx;
}

/** The workspace's databases the viewer can open; null while they load. */
export const useDatabaseList = () => useDatabases().list;

/** A database's details: undefined while they load, null when it can't be opened. */
export function useDatabaseInfo(id: string | null | undefined): DatabaseInfo | null | undefined {
  const { infos, load } = useDatabases();
  useEffect(() => {
    if (id) load(id);
  }, [id, load]);
  return id ? infos[id] : undefined;
}

/** Loads these databases and gives their properties by id, once loaded. */
export function useSchemas(ids: string[]) {
  const { infos, load } = useDatabases();
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  useEffect(() => {
    for (const id of key.split(",")) if (id) load(id);
  }, [key, load]);
  return useCallback((id: string) => infos[id]?.properties, [infos]);
}

export const useReloadDatabase = () => useDatabases().reload;

export const useAutomationWorkspace = () => useDatabases().workspaceId;

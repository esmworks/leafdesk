"use client";

import { ArrowUpRight, ChevronDown, Lock, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { embedInfoAction } from "@/app/actions/embeds";
import { restorePageAction } from "@/app/actions/pages";
import { useChannel } from "@/components/collab/use-channel";
import { DatabasePage } from "@/components/database/database-page";
import { Floating, useFloating } from "@/components/database/floating";
import { ViewIcon } from "@/components/database/property-icons";
import type { DatabaseSnapshot, Property } from "@/components/database/types";
import { Button, cn, MenuItem, PageIcon, pageLabel } from "@/components/ui";
import type { ViewConfig, ViewType } from "@/db/schema/app";
import { chartGroupProperty } from "@/lib/chart";
import { LINKED_VIEW_TYPES, type LinkedView } from "@/lib/embed-blocks";
import type { EmbedInfo } from "@/server/embeds";
import type * as Y from "yjs";
import { hasLevel } from "./page-header-actions";

/** The page whose body shows the blocks: where new inline databases go and who may change it. */
export type EmbedHost = {
  workspaceId: string;
  pageId: string;
  editable: boolean;
  /** The page's document (new synced blocks keep their blocks in it, see synced-block.tsx). */
  doc?: Y.Doc;
};

const EmbedHostContext = createContext<EmbedHost | null>(null);
export const EmbedHostProvider = EmbedHostContext.Provider;
export const useEmbedHost = () => useContext(EmbedHostContext);

/**
 * A database inside a page body: an inline database, or a linked view with its own settings.
 * What it shows follows the reader's access to the database, not to the page: without it the
 * block says only that the database isn't available, never its name or rows.
 */
export function DatabaseEmbed({
  databaseId,
  linked,
  bare,
}: {
  databaseId: string;
  /** Linked views: their settings, and how to change them (only when the page is editable). */
  linked?: { view: LinkedView; onChange?: (view: LinkedView) => void };
  /** Without the database's title above it: a dashboard widget, which has its own. */
  bare?: boolean;
}) {
  const t = useTranslations("page.embed");
  const tc = useTranslations("common");
  const host = useEmbedHost();
  const [info, setInfo] = useState<EmbedInfo | null>(null);
  const [restoring, startRestore] = useTransition();

  const load = useCallback(async () => {
    let next: EmbedInfo;
    try {
      next = await embedInfoAction(databaseId);
    } catch {
      next = { state: "unavailable" };
    }
    // Most tree changes are about other pages: keep the same object so nothing below re-renders.
    setInfo((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [databaseId]);
  useEffect(() => {
    void load();
  }, [load]);

  // Trashing, restoring, moving and sharing all refresh the workspace's page tree: check again.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useChannel(host ? `ws:${host.workspaceId}` : null, (event) => {
    if (event !== "tree") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 150);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const embed = useMemo(
    () => ({ linked, header: bare ? undefined : (snapshot: DatabaseSnapshot) => <EmbedHeader snapshot={snapshot} linked={linked} /> }),
    [linked, bare],
  );

  if (!info) {
    return (
      <Frame>
        <div aria-busy="true" aria-label={tc("loading")} className="h-24 animate-pulse rounded-md bg-bg-subtle" />
      </Frame>
    );
  }

  if (info.state === "unavailable") {
    return (
      <Frame>
        <Notice icon={<Lock className="h-4 w-4 shrink-0" />}>{t("unavailable")}</Notice>
      </Frame>
    );
  }

  if (info.archived) {
    return (
      <Frame>
        <Notice icon={<Trash2 className="h-4 w-4 shrink-0" />}>
          <span className="flex-1">{t("inTrash")}</span>
          {hasLevel(info.level, "edit") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={restoring}
              onClick={() =>
                startRestore(async () => {
                  try {
                    await restorePageAction(databaseId);
                  } finally {
                    await load();
                  }
                })
              }
            >
              <RotateCcw className="h-3.5 w-3.5" /> {tc("restore")}
            </Button>
          )}
        </Notice>
      </Frame>
    );
  }

  return (
    <Frame>
      <DatabasePage
        workspaceId={info.workspaceId}
        databaseId={databaseId}
        canEdit={hasLevel(info.level, "edit")}
        canComment={hasLevel(info.level, "comment")}
        guest={info.guest}
        exportable={info.exportable}
        embed={embed}
      />
    </Frame>
  );
}

/** Keeps the database inside the editor column; wide views scroll sideways within it. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="database-embed my-1 w-full min-w-0">{children}</div>;
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
      {icon}
      {children}
    </div>
  );
}

function EmbedHeader({
  snapshot,
  linked,
}: {
  snapshot: DatabaseSnapshot;
  linked?: { view: LinkedView; onChange?: (view: LinkedView) => void };
}) {
  const t = useTranslations("page.embed");
  const tc = useTranslations("common");
  const { database } = snapshot;
  const href = `/w/${database.workspaceId}/p/${database.id}`;
  return (
    <div className="flex min-w-0 items-center gap-2 pb-1">
      <Link
        href={href}
        title={t("open")}
        className="group flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 -ms-1 text-base font-semibold hover:bg-bg-hover"
      >
        <PageIcon icon={database.icon} kind="database" className="text-base" />
        <span className="truncate">{pageLabel(database.title, tc("untitled"))}</span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
      {linked && (
        <>
          <span className="shrink-0 text-xs text-fg-faint">{t("linked")}</span>
          <LayoutMenu view={linked.view} properties={snapshot.properties} onChange={linked.onChange} />
        </>
      )}
    </div>
  );
}

/** Settings a view of this type starts with, like a new view of the database (see databases.addView). */
function startingConfig(type: ViewType, config: ViewConfig, properties: Property[]): ViewConfig {
  const next = { ...config };
  const firstDate = properties.find((p) => p.type === "date")?.id;
  if (type === "board" && !next.groupBy) next.groupBy = properties.find((p) => p.type === "select" || p.type === "status")?.id;
  if (type === "chart" && !next.groupBy) next.groupBy = chartGroupProperty(properties, {})?.id;
  if ((type === "calendar" || type === "timeline") && !next.dateBy) next.dateBy = firstDate;
  if (type === "map" && !next.placeBy) next.placeBy = properties.find((p) => p.type === "place")?.id;
  return next;
}

/** A linked view picks its own layout: table, board, calendar, gallery, list, feed, timeline, map or chart. */
function LayoutMenu({
  view,
  properties,
  onChange,
}: {
  view: LinkedView;
  properties: Property[];
  onChange?: (view: LinkedView) => void;
}) {
  const t = useTranslations("page.embed");
  const td = useTranslations("database");
  const menu = useFloating<HTMLButtonElement>();
  if (!onChange) {
    return (
      <span className="ms-auto flex shrink-0 items-center gap-1 text-xs text-fg-muted" title={t("viewOnly")}>
        <ViewIcon type={view.type} />
        {td(`views.${view.type}`)}
      </span>
    );
  }
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        onClick={menu.toggle}
        aria-label={t("layout")}
        className="ms-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <ViewIcon type={view.type} />
        {td(`views.${view.type}`)}
        <ChevronDown className="h-3 w-3" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
        <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{t("layout")}</div>
        {LINKED_VIEW_TYPES.map((type) => (
          <MenuItem
            key={type}
            icon={<ViewIcon type={type} />}
            onClick={() => {
              menu.close();
              if (type !== view.type) onChange({ type, config: startingConfig(type, view.config, properties) });
            }}
          >
            <span className={cn(type === view.type && "font-medium")}>{td(`views.${type}`)}</span>
          </MenuItem>
        ))}
      </Floating>
    </>
  );
}

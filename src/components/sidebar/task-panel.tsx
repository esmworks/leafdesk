"use client";

import { CalendarCheck, CalendarDays, CalendarOff, FileText, ListTodo, SquareCheck, Table2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { read } from "@/components/read";
import { cn } from "@/components/ui";
import { panelHeading, panelIcon, panelMeta, panelMore, panelRow, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { isTaskView, SHARED_PLACE, type TaskView } from "@/lib/assigned";
import { pageLabel } from "@/lib/labels";
import { TASKS_EVENT } from "@/lib/tasks-event";
import type { TaskCounts, TaskPlace } from "@/server/assigned";

/** How often the counts are read again while the tab is shown. */
const COUNTS_MS = 60_000;
/** Places shown before "Show all". */
const PLACES_SHOWN = 8;

const VIEW_ICONS: Record<TaskView, typeof ListTodo> = {
  all: ListTodo,
  today: CalendarCheck,
  soon: CalendarDays,
  undated: CalendarOff,
  rows: Table2,
  todos: SquareCheck,
};

export type TaskPanelProps = {
  workspaceId: string;
  /** The page shown is My tasks, with its `?view=`, `?in=` and `?by=`. */
  onTasksPage: boolean;
  /** `?view=` as written. */
  view: string | null;
  place: string | null;
  by: string | null;
  /** Overdue items: today's count is drawn in the danger color then. */
  overdue: number;
  offline: boolean;
};

/**
 * The sidebar's tasks tab: the views of My tasks and the databases and pages its items are in (the
 * person's own list among them, server/own-tasks.ts), each with how many items it holds (server/assigned.ts
 * taskCounts). Each opens My tasks narrowed to it (`?view=`, `?in=`).
 */
export function TaskPanel({ workspaceId, onTasksPage, view: viewParam, place, by, overdue, offline }: TaskPanelProps) {
  const view = isTaskView(viewParam) ? viewParam : "all";
  const t = useTranslations("home.myTasks");
  const tc = useTranslations("common");
  const [counts, setCounts] = useState<TaskCounts | null>(null);
  const [allPlaces, setAllPlaces] = useState(false);

  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    read("taskCounts", workspaceId)
      .then((result) => result && setCounts(result))
      .catch(() => {});
  }, [workspaceId]);
  useEffect(() => {
    if (offline) return;
    load();
    const timer = setInterval(load, COUNTS_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener(TASKS_EVENT, load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener(TASKS_EVENT, load);
    };
  }, [offline, load]);

  const href = (narrow: { view?: TaskView; in?: string }) => {
    const query = new URLSearchParams({ ...(by ? { by } : {}), ...(narrow.view && narrow.view !== "all" ? { view: narrow.view } : {}), ...(narrow.in ? { in: narrow.in } : {}) });
    return `/w/${workspaceId}/tasks${query.size ? `?${query}` : ""}`;
  };
  const viewRow = (key: TaskView) => {
    const Icon = VIEW_ICONS[key];
    const count = counts?.views[key];
    const current = onTasksPage && !place && view === key;
    return (
      <li key={key}>
        <Link href={href({ view: key })} aria-current={current ? "page" : undefined} className={cn(panelRow, current && panelRowActive)}>
          <Icon className={panelIcon} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t(`views.${key}`)}</span>
          {!!count && <span className={cn(panelMeta, key === "today" && overdue > 0 && "text-danger")}>{count}</span>}
        </Link>
      </li>
    );
  };
  const places = counts?.places ?? [];
  const shownPlaces = allPlaces ? places : places.slice(0, PLACES_SHOWN);

  return (
    <div className="flex flex-col">
      <ul className="space-y-px" aria-label={t("viewsLabel")}>
        {(["all", "today", "soon", "undated"] as const).map(viewRow)}
      </ul>
      <section aria-labelledby="task-kinds-heading" className={panelSection}>
        <h3 id="task-kinds-heading" className={panelHeading}>
          {t("byKind")}
        </h3>
        <ul className="space-y-px">{(["rows", "todos"] as const).map(viewRow)}</ul>
      </section>
      {places.length > 0 && (
        <section aria-labelledby="task-places-heading" className={panelSection}>
          <h3 id="task-places-heading" className={panelHeading}>
            {t("places")}
          </h3>
          <ul className="space-y-px">
            {shownPlaces.map((p) => {
              const current = onTasksPage && place === p.id;
              return (
                <li key={p.id}>
                  <Link href={href({ in: p.id })} aria-current={current ? "page" : undefined} className={cn(panelRow, current && panelRowActive)}>
                    <PlaceIcon place={p} />
                    <span className="min-w-0 flex-1 truncate">{p.id === SHARED_PLACE ? t("sharedRows") : pageLabel(p.title, tc("untitled"))}</span>
                    <span className={panelMeta}>{p.count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {places.length > PLACES_SHOWN && (
            <button type="button" onClick={() => setAllPlaces(!allPlaces)} className={panelMore}>
              {allPlaces ? t("fewerPlaces") : t("allPlaces", { count: places.length })}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function PlaceIcon({ place }: { place: TaskPlace }) {
  if (place.icon) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <IconGlyph icon={place.icon} className="text-sm" />
      </span>
    );
  }
  const Icon = place.id === SHARED_PLACE ? Users : place.kind === "database" ? Table2 : FileText;
  return <Icon className={panelIcon} aria-hidden />;
}

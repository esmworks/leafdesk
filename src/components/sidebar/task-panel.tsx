"use client";

import { CalendarCheck, CalendarDays, CalendarOff, FileText, ListTodo, Plus, SquareCheck, Table2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { addOwnTodoAction } from "@/app/actions/assigned";
import { IconGlyph } from "@/components/builtin-icon";
import { read } from "@/components/read";
import { cn } from "@/components/ui";
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
  /** Whether the person may add daily notes, where a to-do written here goes. */
  canAdd: boolean;
  offline: boolean;
  /** After a to-do is added: My tasks reads its list again. */
  onAdded: () => void;
};

/**
 * The sidebar's tasks tab: a box that adds a to-do to today's daily note, the views of My tasks and
 * the databases and pages its items are in, each with how many items it holds (server/assigned.ts
 * taskCounts). Each opens My tasks narrowed to it (`?view=`, `?in=`).
 */
export function TaskPanel({ workspaceId, onTasksPage, view: viewParam, place, by, overdue, canAdd, offline, onAdded }: TaskPanelProps) {
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
    return (
      <li key={key}>
        <Link href={href({ view: key })} aria-current={onTasksPage && !place && view === key ? "page" : undefined} className={rowClass}>
          <Icon className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t(`views.${key}`)}</span>
          {!!count && <span className={cn("text-xs tabular-nums", key === "today" && overdue > 0 ? "text-danger" : "text-fg-faint")}>{count}</span>}
        </Link>
      </li>
    );
  };
  const places = counts?.places ?? [];
  const shownPlaces = allPlaces ? places : places.slice(0, PLACES_SHOWN);

  return (
    <div className="flex flex-col">
      {canAdd && <AddTodo workspaceId={workspaceId} offline={offline} onAdded={() => {
            window.dispatchEvent(new Event(TASKS_EVENT));
            onAdded();
          }} />}
      <ul className="space-y-px" aria-label={t("viewsLabel")}>
        {(["all", "today", "soon", "undated"] as const).map(viewRow)}
      </ul>
      <h3 className={headingClass}>{t("byKind")}</h3>
      <ul className="space-y-px">{(["rows", "todos"] as const).map(viewRow)}</ul>
      {places.length > 0 && (
        <section aria-labelledby="task-places-heading">
          <h3 id="task-places-heading" className={headingClass}>
            {t("places")}
          </h3>
          <ul className="space-y-px">
            {shownPlaces.map((p) => (
              <li key={p.id}>
                <Link href={href({ in: p.id })} aria-current={onTasksPage && place === p.id ? "page" : undefined} className={rowClass}>
                  <PlaceIcon place={p} />
                  <span className="min-w-0 flex-1 truncate">{p.id === SHARED_PLACE ? t("sharedRows") : pageLabel(p.title, tc("untitled"))}</span>
                  <span className="text-xs tabular-nums text-fg-faint">{p.count}</span>
                </Link>
              </li>
            ))}
          </ul>
          {places.length > PLACES_SHOWN && (
            <button type="button" onClick={() => setAllPlaces(!allPlaces)} className="mt-px flex h-7 w-full items-center rounded-md px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg">
              {allPlaces ? t("fewerPlaces") : t("allPlaces", { count: places.length })}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

const rowClass = "flex h-7 items-center gap-2 rounded-md px-2 text-sm hover:bg-bg-hover aria-[current=page]:bg-bg-active aria-[current=page]:text-fg";
const headingClass = "flex h-7 items-end px-2 pt-3 pb-1 text-xs font-medium text-fg-faint";

function PlaceIcon({ place }: { place: TaskPlace }) {
  if (place.icon) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <IconGlyph icon={place.icon} className="text-sm" />
      </span>
    );
  }
  const Icon = place.id === SHARED_PLACE ? Users : place.kind === "database" ? Table2 : FileText;
  return <Icon className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />;
}

/** The box at the top: Enter adds what is written as a to-do in today's daily note. */
function AddTodo({ workspaceId, offline, onAdded }: { workspaceId: string; offline: boolean; onAdded: () => void }) {
  const t = useTranslations("home.myTasks");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const adding = useRef(false);

  async function add() {
    if (adding.current || !text.trim()) return;
    adding.current = true;
    setError(null);
    try {
      const result = await addOwnTodoAction(workspaceId, text);
      if (!result.ok) return setError(result.error);
      setText("");
      onAdded();
    } catch {
      setError(t("addFailed"));
    } finally {
      adding.current = false;
    }
  }

  return (
    <div className="mb-2">
      <label className="flex h-8 items-center gap-2 rounded-md border border-transparent bg-bg-hover ps-2.5 pe-2 text-fg-icon focus-within:border-border focus-within:bg-bg">
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <input
          value={text}
          disabled={offline}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            } else if (e.key === "Escape") {
              setText("");
              e.currentTarget.blur();
            }
          }}
          placeholder={t("addTodo")}
          aria-label={t("addTodo")}
          aria-describedby="add-todo-hint"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint disabled:cursor-default"
        />
      </label>
      {error ? (
        <p role="alert" className="px-2 pt-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        text && (
          <p id="add-todo-hint" className="px-2 pt-1 text-xs text-fg-faint">
            {t("addHint")}
          </p>
        )
      )}
    </div>
  );
}

"use client";

import { CalendarPlus, CircleCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { useDurationText } from "@/components/calendar/duration";
import { read } from "@/components/read";
import { cn, IconButton, Input } from "@/components/ui";
import { dayNumber } from "@/lib/time-zone";
import { matchesTaskFilter, type TaskToPlan } from "@/lib/work-blocks";

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

/**
 * The Calendar's To plan list: the person's open tasks (as My tasks lists them, server/work-blocks.ts
 * tasksToPlan), each with the time planned for it, by due date then title, with a filter box. A task
 * is dragged onto the week's hours (`onDragTask`) or planned through its Plan time button, which
 * works without dragging (phones, the keyboard). Read again as `version` changes.
 */
export function ToPlanList({
  workspaceId,
  version,
  onDragTask,
  onPlan,
}: {
  workspaceId: string;
  version: number;
  onDragTask: (task: TaskToPlan | null) => void;
  onPlan: (task: TaskToPlan) => void;
}) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const duration = useDurationText();
  const [tasks, setTasks] = useState<TaskToPlan[] | null | "failed">(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      read("tasksToPlan", workspaceId)
        .then((result) => live && setTasks(result ?? "failed"))
        .catch(() => live && setTasks("failed"));
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [workspaceId, version]);
  const shown = useMemo(() => (Array.isArray(tasks) ? tasks.filter((task) => matchesTaskFilter(task, query)) : []), [tasks, query]);

  const startDrag = (e: DragEvent<HTMLElement>, task: TaskToPlan) => {
    e.dataTransfer.effectAllowed = "copy";
    // Some browsers start a drag only with data on it.
    e.dataTransfer.setData("text/plain", task.title);
    onDragTask(task);
  };

  return (
    <section aria-labelledby="calendar-to-plan" className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h2 id="calendar-to-plan" className="text-sm font-medium text-fg">
          {t("toPlan.title")}
        </h2>
        <p className="text-[13px] text-fg-muted">{t("toPlan.help")}</p>
      </div>
      <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("toPlan.filter")} aria-label={t("toPlan.filter")} className="h-8" />
      {tasks === "failed" ? (
        <p className="py-2 text-xs text-fg-faint">{t("toPlan.couldNotLoad")}</p>
      ) : tasks === null ? null : shown.length === 0 ? (
        <p className="py-2 text-xs text-fg-faint">{tasks.length ? t("toPlan.noMatch") : t("toPlan.empty")}</p>
      ) : (
        <ul className="-mx-2">
          {shown.map((task) => {
            const meta = [
              task.date ? format.dateTime(utcDay(dayNumber(task.date)), { day: "numeric", month: "short", timeZone: "UTC" }) : null,
              task.plannedMinutes > 0 ? t("toPlan.planned", { duration: duration(task.plannedMinutes) }) : null,
            ].filter(Boolean);
            return (
              <li
                key={task.key}
                draggable
                onDragStart={(e) => startDrag(e, task)}
                onDragEnd={() => onDragTask(null)}
                className="group flex min-h-10 cursor-grab items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover active:cursor-grabbing"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-icon">
                  {task.icon ? <IconGlyph icon={task.icon} className="text-sm" /> : <CircleCheck className="h-4 w-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg" title={[task.title, task.detail].filter(Boolean).join(" · ")}>
                    {task.title.trim() || t("untitled")}
                  </span>
                  {meta.length > 0 && <span className="block truncate text-xs tabular-nums text-fg-faint">{meta.join(" · ")}</span>}
                </span>
                <IconButton
                  label={t("toPlan.planTime")}
                  onClick={() => onPlan(task)}
                  className={cn("h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100")}
                >
                  <CalendarPlus className="h-4 w-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

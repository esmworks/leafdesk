"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import type { NewTaskFormProps, TaskPerson } from "./new-task-form";

export type { TaskPerson };

/** The form, with the date words and the calendar: loaded apart from the page, after it. */
const NewTaskForm = lazyPart<NewTaskFormProps>(
  () => import("./new-task-form").then((m) => m.NewTaskForm),
  () => <div className="h-[5.5rem] rounded-xl border border-border bg-bg" />,
);

/**
 * My tasks' New task row: opens a form that adds a task to the person's own list
 * (server/own-tasks.ts) with a day, a priority and others it is for.
 */
export function NewTask({ workspaceId, today, people }: { workspaceId: string; today: string; people: TaskPerson[] }) {
  const t = useTranslations("home.myTasks");
  const [open, setOpen] = useState(false);
  // Loaded once the page is up, so the form is ready for what is typed the moment it opens.
  useEffect(() => void NewTaskForm.preload(), []);
  if (open) return <NewTaskForm workspaceId={workspaceId} today={today} people={people} onClose={() => setOpen(false)} />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden />
      {t("newTask")}
    </button>
  );
}

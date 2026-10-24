"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { completeSprintAction, getSprintsAction, setSprintsAction } from "@/app/actions/databases";
import { Button, cn, Dialog, Input, pageLabel, selectClass } from "@/components/ui";
import { formatDateValueIn } from "@/lib/date-value";
import { MAX_SPRINT_WEEKS, MIN_SPRINT_WEEKS } from "@/lib/sprints";
import { browserTimeZone, timestampDay } from "@/lib/time-zone";
import type { SprintCompletionResult, SprintsInfo } from "@/server/sprints";

const WEEKS = Array.from({ length: MAX_SPRINT_WEEKS - MIN_SPRINT_WEEKS + 1 }, (_, i) => MIN_SPRINT_WEEKS + i);

/**
 * Sprints of a task database (server/sprints): turning them on with a sprint length and the first
 * sprint's day, how long new sprints are, the current and next sprint, and turning them off. On a
 * sprints database it says whose sprints it holds.
 */
export function SprintsDialog({
  workspaceId,
  databaseId,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  databaseId: string;
  onClose: () => void;
  /** Refetches the database; `viewId`: the current sprint's board, to open after turning sprints on. */
  onChanged: (viewId?: string) => void;
}) {
  const t = useTranslations("database.sprints");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [info, setInfo] = useState<SprintsInfo | null>(null);
  const [weeks, setWeeks] = useState(2);
  const [start, setStart] = useState(() => timestampDay(new Date(), browserTimeZone()) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    void getSprintsAction(databaseId).then((result) => {
      if (!live) return;
      if (!result.ok) return setError(result.error);
      setInfo(result.data);
      if (result.data.side === "tasks" && result.data.on) setWeeks(result.data.weeks);
    });
    return () => {
      live = false;
    };
  }, [databaseId]);

  const save = (input: { on: boolean; weeks?: number; start?: string }, close: boolean) => {
    setError(null);
    startTransition(async () => {
      const wasOn = info?.side === "tasks" && info.on;
      const result = await setSprintsAction(databaseId, input);
      if (!result.ok) return setError(result.error);
      setInfo(result.data);
      const after = result.data;
      onChanged(!wasOn && after.side === "tasks" && after.on ? (after.boardViewId ?? undefined) : undefined);
      if (close) onClose();
    });
  };

  const dates = (value: string | null) => (value && formatDateValueIn(value, locale, "UTC")) || null;
  const sprintLine = (label: string, sprint: { title: string; dates: string | null } | null) => (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="truncate text-end">
        {sprint ? pageLabel(sprint.title, tc("untitled")) : t("none")}
        {sprint && dates(sprint.dates) && <span className="ms-2 text-fg-muted">{dates(sprint.dates)}</span>}
      </span>
    </div>
  );
  const lengthField = (
    <div className="space-y-1">
      <label htmlFor="sprint-weeks" className="block text-xs font-medium text-fg-muted">
        {t("length")}
      </label>
      <select id="sprint-weeks" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className={cn(selectClass, "w-full")}>
        {WEEKS.map((n) => (
          <option key={n} value={n}>
            {t("weeks", { count: n })}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className={cn("space-y-4 p-5", (!info || pending) && "pointer-events-none opacity-60")} aria-busy={!info || pending}>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="text-sm text-fg-muted">{t("description")}</p>
        </div>

        {info?.side === "sprints" && (
          <p className="text-sm">
            {t("holdsSprints", { name: pageLabel(info.tasksDatabase.title, tc("untitled")) })}{" "}
            <Link href={`/w/${workspaceId}/p/${info.tasksDatabase.id}`} className="text-accent hover:underline" onClick={onClose}>
              {t("open")}
            </Link>
          </p>
        )}

        {info?.side === "tasks" && !info.on && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save({ on: true, weeks, ...(info.again ? {} : { start }) }, true);
            }}
          >
            {info.again ? (
              <p className="text-sm">{t("again", { name: pageLabel(info.again.title, tc("untitled")) })}</p>
            ) : (
              <p className="text-sm text-fg-muted">{t("turnOnHint")}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              {lengthField}
              {!info.again && (
                <div className="space-y-1">
                  <label htmlFor="sprint-start" className="block text-xs font-medium text-fg-muted">
                    {t("start")}
                  </label>
                  <Input id="sprint-start" type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
              )}
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {tc("cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={pending || (!info.again && !start)}>
                {t("turnOn")}
              </Button>
            </div>
          </form>
        )}

        {info?.side === "tasks" && info.on && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save({ on: true, weeks }, true);
            }}
          >
            {info.sprintsDatabase ? (
              <p className="text-sm">
                {t("keptIn", { name: pageLabel(info.sprintsDatabase.title, tc("untitled")) })}{" "}
                <Link href={`/w/${workspaceId}/p/${info.sprintsDatabase.id}`} className="text-accent hover:underline" onClick={onClose}>
                  {t("open")}
                </Link>
              </p>
            ) : (
              <p className="text-sm text-danger">{t("unusable")}</p>
            )}
            <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
              {sprintLine(t("current"), info.current)}
              {sprintLine(t("next"), info.next)}
            </div>
            <div className="space-y-1">
              {lengthField}
              <p className="text-xs text-fg-muted">{t("lengthHint")}</p>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                title={t("turnOffHint")}
                onClick={() => save({ on: false }, true)}
                className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-danger hover:bg-bg-hover"
              >
                {t("turnOff")}
              </button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>
                  {tc("cancel")}
                </Button>
                <Button type="submit" variant="primary" disabled={pending || weeks === info.weeks}>
                  {pending ? tc("saving") : tc("save")}
                </Button>
              </div>
            </div>
          </form>
        )}

        {!info && error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * Asks before completing the current sprint, saying what changes (the sprint completed, the one
 * that becomes current, the next one, the tasks carried over), worked out by the server as it
 * would do it.
 */
export function CompleteSprintDialog({
  databaseId,
  onClose,
  onDone,
}: {
  databaseId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("database.sprints");
  const tc = useTranslations("common");
  const [preview, setPreview] = useState<SprintCompletionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    void completeSprintAction(databaseId, true).then((result) => {
      if (!live) return;
      if (!result.ok) setError(result.error);
      else setPreview(result.data);
    });
    return () => {
      live = false;
    };
  }, [databaseId]);

  const complete = () => {
    setError(null);
    startTransition(async () => {
      const result = await completeSprintAction(databaseId);
      if (!result.ok) return setError(result.error);
      onDone();
      onClose();
    });
  };

  const title = (value: string) => pageLabel(value, tc("untitled"));
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className={cn("space-y-4 p-5", pending && "pointer-events-none opacity-60")} aria-busy={pending || (!preview && !error)}>
        <h2 className="text-base font-semibold">{preview ? t("completeTitle", { title: title(preview.completed.title) }) : t("complete")}</h2>
        {!preview && !error && <p className="text-sm text-fg-muted">{t("completeLoading")}</p>}
        {preview && (
          <ul className="list-disc space-y-1 ps-5 text-sm">
            <li>{t("completeCompleted", { title: title(preview.completed.title) })}</li>
            <li>{t(preview.current.created ? "completeCurrentNew" : "completeCurrent", { title: title(preview.current.title) })}</li>
            <li>{t(preview.next.created ? "completeNextNew" : "completeNext", { title: title(preview.next.title) })}</li>
            <li>{t("completeMoved", { count: preview.moved, title: title(preview.current.title) })}</li>
            {preview.skipped > 0 && <li>{t("completeSkipped", { count: preview.skipped })}</li>}
          </ul>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="primary" onClick={complete} disabled={!preview || pending}>
            {t("complete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { planWorkBlockAction } from "@/app/actions/work-blocks";
import { useDurationText } from "@/components/calendar/duration";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass } from "@/components/ui";
import { isDay } from "@/lib/date-value";
import { dayNumber, dayString, zonedInstant } from "@/lib/time-zone";
import { WORK_BLOCK_DEFAULT_MINUTES, WORK_BLOCK_LENGTHS, WORK_BLOCK_STEP_MINUTES, type TaskToPlan } from "@/lib/work-blocks";

/** Every start a block may have in a day, a step apart. */
const STARTS = Array.from({ length: (24 * 60) / WORK_BLOCK_STEP_MINUTES }, (_, i) => i * WORK_BLOCK_STEP_MINUTES);

/**
 * Plan time for a task without dragging (phones, the keyboard): a day, a start and a length, as the
 * person's clock reads them. `day` and `start` are what it opens with (a day number, minutes past
 * midnight); `onPlanned` hears the day planned on.
 */
export function PlanTimeDialog({
  workspaceId,
  task,
  timeZone,
  day: initialDay,
  start: initialStart,
  onClose,
  onPlanned,
}: {
  workspaceId: string;
  task: TaskToPlan;
  timeZone: string;
  day: number;
  start: number;
  onClose: () => void;
  onPlanned: (day: number) => void;
}) {
  const t = useTranslations("calendar");
  const common = useTranslations("common");
  const format = useFormatter();
  const duration = useDurationText();
  const [day, setDay] = useState(dayString(initialDay));
  const [start, setStart] = useState(initialStart);
  const [length, setLength] = useState(WORK_BLOCK_DEFAULT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clock = (minutes: number) => format.dateTime(new Date(minutes * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isDay(day)) return setError(t("blockErrors.invalid"));
    setBusy(true);
    setError(null);
    const at = new Date(zonedInstant(dayNumber(day), start, timeZone)).toISOString();
    const result = await planWorkBlockAction(workspaceId, task.ref, at, length).catch(() => ({ ok: false, error: "failed" }) as const);
    setBusy(false);
    if (!result.ok) return setError(t(`blockErrors.${result.error}`));
    onPlanned(dayNumber(day));
  };

  return (
    <Dialog open onClose={onClose} className="max-w-sm">
      <form onSubmit={submit}>
        <DialogHeader title={t("planDialog.title")} description={<span className="block truncate">{task.title.trim() || t("untitled")}</span>} onClose={onClose} closeLabel={common("close")} />
        <DialogBody>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">{t("planDialog.day")}</span>
            <Input type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <div className="flex gap-4">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">{t("planDialog.start")}</span>
              <select value={start} onChange={(e) => setStart(Number(e.target.value))} className={`${selectClass} w-full`}>
                {STARTS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {clock(minutes)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">{t("planDialog.length")}</span>
              <select value={length} onChange={(e) => setLength(Number(e.target.value))} className={`${selectClass} w-full`}>
                {WORK_BLOCK_LENGTHS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {duration(minutes)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {common("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !isDay(day)}>
            {t("planDialog.plan")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

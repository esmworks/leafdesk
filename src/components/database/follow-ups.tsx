"use client";

import { Repeat } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { enrollRowsAction, listSequencesAction, resumeEnrollmentAction, rowFollowUpsAction, stopEnrollmentAction, type RowFollowUps } from "@/app/actions/sequences";
import { Button, cn, MenuItem, Popover } from "@/components/ui";
import type { EmailDraftProblem } from "@/lib/email-draft-check";
import { isOpenEnrollment, type EnrollmentView } from "@/lib/sequences";

/** How many ended follow-ups the row shows under those going on. */
const ENDED_SHOWN = 3;

/**
 * A row's follow-ups (server/sequences), for its email section (row-emails.tsx): `start` is the
 * "Start follow-up" menu for its header, `list` what each one is doing. `onChange` runs after
 * one starts, stops or resumes, so the section can show the email it may have sent.
 */
export function useRowFollowUps(rowId: string, onChange?: () => void) {
  const [data, setData] = useState<RowFollowUps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await rowFollowUpsAction(rowId);
      if (mine !== seq.current) return;
      if (result.ok) setData(result.data);
    } catch {
      // The section works without them: nothing to show.
    }
  }, [rowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) setError(result.error);
      await load();
      onChange?.();
    } finally {
      setBusy(false);
    }
  };

  const start = (sequenceId: string) =>
    act(async () => {
      const result = await enrollRowsAction(sequenceId, [rowId], "row");
      if (!result.ok) return result;
      const [outcome] = result.data;
      return outcome && !outcome.ok ? { ok: false as const, error: outcome.error } : { ok: true as const };
    });

  return {
    data,
    error,
    busy,
    start,
    stop: (id: string) => act(() => stopEnrollmentAction(id)),
    resume: (id: string) => act(() => resumeEnrollmentAction(id)),
  };
}

type FollowUpState = ReturnType<typeof useRowFollowUps>;

/** "Start follow-up": the database's sequences not going on the row already. */
export function StartFollowUp({ state }: { state: FollowUpState }) {
  const t = useTranslations("database.followUps");
  const sequences = state.data?.sequences ?? [];
  if (!sequences.length) return null;
  const going = new Set((state.data?.enrollments ?? []).filter((e) => isOpenEnrollment(e.status)).map((e) => e.sequence.id));
  return (
    <Popover
      trigger={({ toggle }) => (
        <Button size="sm" variant="ghost" disabled={state.busy} onClick={toggle} aria-haspopup="menu">
          {t("start")}
        </Button>
      )}
    >
      {(close) =>
        sequences.map((s) => (
          <MenuItem
            key={s.id}
            icon={<Repeat className="h-3.5 w-3.5" />}
            disabled={going.has(s.id)}
            title={going.has(s.id) ? t("alreadyGoing") : undefined}
            trailing={<span className="text-xs tabular-nums">{t("stepCount", { count: s.steps })}</span>}
            onClick={() => {
              close();
              void state.start(s.id);
            }}
          >
            {s.name}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

/** The row's follow-ups: those going on, with Stop and Resume, then the last few that ended. */
export function FollowUpList({ state }: { state: FollowUpState }) {
  const all = state.data?.enrollments ?? [];
  const open = all.filter((e) => isOpenEnrollment(e.status));
  const ended = all.filter((e) => !isOpenEnrollment(e.status)).slice(0, ENDED_SHOWN);
  if (!open.length && !ended.length && !state.error) return null;
  return (
    <div className="space-y-1">
      {[...open, ...ended].map((e) => (
        <FollowUpLine key={e.id} enrollment={e} busy={state.busy} onStop={() => void state.stop(e.id)} onResume={() => void state.resume(e.id)} />
      ))}
      {state.error && <p className="text-xs text-danger">{state.error}</p>}
    </div>
  );
}

function FollowUpLine({ enrollment: e, busy, onStop, onResume }: { enrollment: EnrollmentView; busy: boolean; onStop: () => void; onResume: () => void }) {
  const t = useTranslations("database.followUps");
  const open = isOpenEnrollment(e.status);
  const state = useEnrollmentState(e);
  return (
    <div
      data-follow-up={e.id}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-2.5 py-2", !open && "border-dashed")}
    >
      <Repeat aria-hidden className={cn("h-3.5 w-3.5 shrink-0", open ? "text-fg-muted" : "text-fg-faint")} />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm", open ? "text-fg" : "text-fg-muted")}>
          <bdi>{e.sequence.name}</bdi>
          <span className="text-fg-faint"> · {t("stepOf", { step: e.step, steps: e.steps })}</span>
        </p>
        <p className={cn("text-xs", e.status === "paused" && e.reason === "checkFailed" ? "text-danger" : "text-fg-muted")}>{state}</p>
        <p className="text-xs text-fg-faint">{t("sender", { name: e.sender.name })}</p>
      </div>
      {open && (e.canResume || e.canStop) && (
        <div className="flex shrink-0 gap-1">
          {e.canResume && (
            <Button size="sm" disabled={busy} onClick={onResume}>
              {t("resume")}
            </Button>
          )}
          {e.canStop && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onStop}>
              {t("stop")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const PROBLEMS: EmailDraftProblem[] = ["emptyText", "subjectLineBreak", "placeholder", "markdown", "html", "internal"];

/** What an enrollment is doing, or why it paused or ended, in a sentence. */
export function useEnrollmentState(e: EnrollmentView) {
  const t = useTranslations("database.followUps");
  const format = useFormatter();
  const when = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "");
  const day = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : "");
  switch (e.status) {
    case "active":
      return e.nextAt ? t("state.next", { time: when(e.nextAt) }) : t("state.going");
    case "waiting":
      return t("state.waiting");
    case "paused":
      if (e.reason === "outOfOffice") return t("state.outOfOffice", { date: day(e.pausedUntil) });
      return t("state.checkFailed", {
        problems: (e.problems ?? []).map((p) => (PROBLEMS.includes(p) ? t(`problems.${p}`) : p)).join(", ") || t("problems.other"),
      });
    case "finished":
      return t("state.finished", { count: e.sent });
    case "stopped":
      return t("state.stopped", { reason: e.reason ?? "manual", date: day(e.endedAt) });
  }
}

/**
 * The table's selection bar: starts one of the database's follow-ups on the selected rows, from the
 * viewer's mailbox, and says how many it started on and why the others were skipped.
 */
export function BulkFollowUp({ databaseId, rowIds, className }: { databaseId: string; rowIds: string[]; className: string }) {
  const t = useTranslations("database.followUps");
  const tc = useTranslations("common");
  const [sequences, setSequences] = useState<{ id: string; name: string; steps: number }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ started: number; skipped: string[] } | string | null>(null);

  useEffect(() => {
    let live = true;
    listSequencesAction(databaseId)
      .then((res) => live && res.ok && setSequences(res.data.sequences.map((s) => ({ id: s.id, name: s.name, steps: s.steps.length }))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [databaseId]);

  if (!sequences.length) return null;

  const start = async (sequenceId: string) => {
    setBusy(true);
    try {
      const res = await enrollRowsAction(sequenceId, rowIds, "bulk");
      if (!res.ok) return setResult(res.error);
      const skipped = res.data.flatMap((o) => (o.ok ? [] : [o.error]));
      setResult({ started: res.data.length - skipped.length, skipped });
    } catch {
      setResult(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      side="top"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResult(null);
      }}
      trigger={({ toggle }) => (
        <button type="button" disabled={busy} onClick={toggle} className={className} title={t("start")} aria-haspopup="menu">
          <Repeat className="h-3.5 w-3.5 text-fg-muted" />
          <span className="max-sm:sr-only">{t("start")}</span>
        </button>
      )}
      className="w-72"
    >
      {result === null ? (
        sequences.map((s) => (
          <MenuItem
            key={s.id}
            icon={<Repeat className="h-3.5 w-3.5" />}
            disabled={busy}
            trailing={<span className="text-xs tabular-nums">{t("stepCount", { count: s.steps })}</span>}
            onClick={() => void start(s.id)}
          >
            {s.name}
          </MenuItem>
        ))
      ) : typeof result === "string" ? (
        <p className="px-2 py-1.5 text-sm text-danger">{result}</p>
      ) : (
        <div className="space-y-1 px-2 py-1.5 text-sm">
          <p>{t("bulkStarted", { count: result.started })}</p>
          {result.skipped.length > 0 && (
            <>
              <p className="text-fg-muted">{t("bulkSkipped", { count: result.skipped.length })}</p>
              <ul className="list-disc ps-4 text-xs text-fg-muted">
                {[...new Set(result.skipped)].map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

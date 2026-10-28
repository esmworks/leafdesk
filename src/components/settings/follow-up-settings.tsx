"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { setMailboxSendingAction } from "@/app/actions/row-mail";
import { createSequenceAction, deleteSequenceAction, listSequencesAction, updateSequenceAction } from "@/app/actions/sequences";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, IconButton, Input, PageIcon, pageLabel, selectClass, textareaClass } from "@/components/ui";
import type { MailboxView, MailSettingsView } from "@/lib/mail";
import {
  BUILTIN_VARIABLES,
  DEFAULT_SEND_WINDOW,
  MAX_DAILY_LIMIT,
  MAX_SEQUENCE_NAME,
  MAX_SEQUENCE_STEPS,
  MAX_STEP_DAYS,
  MAX_STEP_SUBJECT,
  MAX_STEP_TEXT,
  templateProblems,
  type SendWindow,
  type SequenceStepMode,
  type SequenceView,
} from "@/lib/sequences";
import { browserTimeZone, listTimeZones, timeZoneLabel } from "@/lib/time-zone";
import { Field } from "./agent-dialog";
import { SettingsGroup, SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Follow-ups in the email settings: the sequences of each database mail lands on (owners write
 * them here, Settings > General > Email), and on a member's own mailbox, how many follow-up emails
 * it sends a day and the time zone their send windows read in (Account > Email and calendar).
 */

type Database = MailSettingsView["databases"][number];

/** The follow-ups of the databases mail lands on, each database in its own group. */
export function SequencesGroups({ databases }: { databases: Database[] }) {
  return databases.map((database) => <SequencesGroup key={database.databaseId} database={database} />);
}

function SequencesGroup({ database }: { database: Database }) {
  const t = useTranslations("settings.followUps");
  const tc = useTranslations("common");
  const [sequences, setSequences] = useState<SequenceView[] | null>(null);
  const [variables, setVariables] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SequenceView | "new" | null>(null);

  useEffect(() => {
    let live = true;
    listSequencesAction(database.databaseId)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setSequences(res.data.sequences);
          setVariables(res.data.variables);
        } else setError(res.error);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [database.databaseId, tc]);

  const title = pageLabel(database.title, tc("untitled"));
  return (
    <SettingsGroup
      title={t("heading", { database: title })}
      description={t("description")}
      action={
        <Button size="sm" disabled={!sequences} onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5" />
          {t("new")}
        </Button>
      }
    >
      {!sequences ? (
        <p className={cn("px-5 py-4 text-sm", error ? "text-danger" : "text-fg-muted")}>{error ?? tc("loading")}</p>
      ) : sequences.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        sequences.map((s) => (
          <SettingsRow
            key={s.id}
            title={s.name}
            description={t("summary", { steps: s.steps.length, open: s.open, review: s.steps.filter((step) => step.mode === "review").length })}
            control={
              <Button size="sm" onClick={() => setEditing(s)}>
                {t("edit")}
              </Button>
            }
          />
        ))
      )}
      {editing && (
        <SequenceDialog
          database={database}
          saved={editing === "new" ? null : editing}
          variables={variables}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setSequences((list) => {
              const rest = (list ?? []).filter((s) => s.id !== saved.id);
              return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name));
            });
            setEditing(null);
          }}
          onDeleted={(id) => {
            setSequences((list) => (list ?? []).filter((s) => s.id !== id));
            setEditing(null);
          }}
        />
      )}
    </SettingsGroup>
  );
}

type DraftStep = { key: string; id: string | null; days: string; subject: string; text: string; mode: SequenceStepMode };

let keys = 0;
const newKey = () => `s${++keys}`;

/** Minutes past midnight as an `<input type="time">` writes them, and back. */
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const minutesOf = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
};

/** Monday first, as most calendars show a week: day numbers as Date.getDay gives them. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * A sequence's editor: its name, its emails in order (each waiting some days after the one before,
 * the first after the row starts it; sent on their own or put in For review first), and when they
 * may go out. Every variable needs a fallback; the server checks the same on save.
 */
function SequenceDialog({
  database,
  saved,
  variables,
  onClose,
  onSaved,
  onDeleted,
}: {
  database: Database;
  saved: SequenceView | null;
  variables: string[];
  onClose: () => void;
  onSaved: (sequence: SequenceView) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("settings.followUps");
  const tf = useTranslations("database.followUps");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [name, setName] = useState(saved?.name ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    saved
      ? saved.steps.map((s) => ({ key: newKey(), id: s.id, days: String(s.days), subject: s.subject, text: s.text, mode: s.mode }))
      : [
          { key: newKey(), id: null, days: "0", subject: "", text: "", mode: "review" },
          { key: newKey(), id: null, days: "3", subject: "", text: "", mode: "review" },
        ],
  );
  const [sendWindow, setSendWindow] = useState<SendWindow>(saved?.window ?? DEFAULT_SEND_WINDOW);
  const { pending, error, run } = useAction();
  const [problem, setProblem] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLTextAreaElement | null>());

  const names = useMemo(() => [...variables, ...BUILTIN_VARIABLES], [variables]);
  const weekday = (n: number) => format.dateTime(new Date(Date.UTC(2026, 0, 4 + n, 12)), { weekday: "short", timeZone: "UTC" });

  const setStep = (key: string, patch: Partial<DraftStep>) => setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (index: number, by: -1 | 1) =>
    setSteps((list) => {
      const next = [...list];
      const to = index + by;
      if (to < 0 || to >= next.length) return list;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  /** Puts `{{Variable | }}` where the caret is in a step's text, and the caret before the closing braces. */
  const insert = (step: DraftStep, variable: string) => {
    const field = fields.current.get(step.key);
    const token = `{{${variable} | }}`;
    const at = field ? field.selectionStart : step.text.length;
    const end = field ? field.selectionEnd : step.text.length;
    setStep(step.key, { text: step.text.slice(0, at) + token + step.text.slice(end) });
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      const caret = at + token.length - 2;
      field.setSelectionRange(caret, caret);
    });
  };

  /** The first thing to fix before saving, as the editor can tell; the server checks again. */
  const check = (): string | null => {
    if (!name.trim()) return tf("errors.name");
    for (const [i, s] of steps.entries()) {
      const inStep = (problem: string) => tf("errors.inStep", { step: i + 1, problem });
      const days = Number(s.days);
      if (!s.days.trim() || !Number.isInteger(days) || days < 0 || days > MAX_STEP_DAYS) return inStep(tf("errors.days"));
      if (i === 0 && !s.subject.trim()) return inStep(tf("errors.subject"));
      if (!s.text.trim()) return inStep(tf("errors.text"));
      const found = templateProblems(`${i === 0 ? s.subject : ""}\n${s.text}`, names)[0];
      if (found) {
        const code = found.problem === "empty" ? "emptyVariable" : found.problem === "noFallback" ? "noFallback" : "unknownVariable";
        return inStep(tf(`errors.${code}`, { name: found.name }));
      }
    }
    if (!sendWindow.days.length || sendWindow.end <= sendWindow.start) return tf("errors.window");
    return null;
  };

  const save = () => {
    const found = check();
    setProblem(found);
    if (found) return;
    const input = {
      name: name.trim(),
      steps: steps.map((s, i) => ({ id: s.id, days: Number(s.days), subject: i === 0 ? s.subject.trim() : "", text: s.text, mode: s.mode })),
      window: sendWindow,
    };
    run(() => (saved ? updateSequenceAction(saved.id, input) : createSequenceAction(database.databaseId, input)), onSaved);
  };

  const remove = () => {
    if (!saved) return;
    if (!confirm(saved.open ? t("confirmDeleteOpen", { name: saved.name, count: saved.open }) : t("confirmDelete", { name: saved.name }))) return;
    run(() => deleteSequenceAction(saved.id), () => onDeleted(saved.id));
  };

  const shown = problem ?? error;
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader
        title={saved ? t("editTitle") : t("newTitle")}
        description={
          <p className="flex items-center gap-1.5 truncate">
            <PageIcon icon={database.icon} kind="database" className="text-sm" />
            {pageLabel(database.title, tc("untitled"))}
          </p>
        }
        onClose={onClose}
        closeLabel={tc("close")}
      />

      <DialogBody className={cn("max-h-[65vh] overflow-y-auto", pending && "pointer-events-none opacity-70")}>
        <Field label={t("name")}>
          <Input value={name} maxLength={MAX_SEQUENCE_NAME} autoFocus={!saved} placeholder={t("namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div>
          <p className="mb-1 text-xs font-medium text-fg-muted">{t("emails")}</p>
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={step.key} className="rounded-lg border border-border p-3" data-step={i + 1}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium">{t("emailN", { n: i + 1 })}</span>
                  <IconButton label={t("moveUp")} disabled={i === 0} onClick={() => move(i, -1)} className="disabled:opacity-40">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label={t("moveDown")} disabled={i === steps.length - 1} onClick={() => move(i, 1)} className="disabled:opacity-40">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t("removeEmail")}
                    disabled={steps.length === 1}
                    onClick={() => setSteps((list) => list.filter((s) => s.key !== step.key))}
                    className="hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <span className="text-fg-muted">{t("wait")}</span>
                    <span className="w-16 shrink-0">
                      <Input
                        type="number"
                        min={0}
                        max={MAX_STEP_DAYS}
                        value={step.days}
                        aria-label={t("waitDays")}
                        onChange={(e) => setStep(step.key, { days: e.target.value })}
                      />
                    </span>
                    <span className="text-fg-muted">{i === 0 ? t("daysAfterStart", { count: Number(step.days) || 0 }) : t("daysAfterPrevious", { count: Number(step.days) || 0 })}</span>
                  </label>
                  <select
                    value={step.mode}
                    aria-label={t("mode")}
                    onChange={(e) => setStep(step.key, { mode: e.target.value as SequenceStepMode })}
                    className={cn(selectClass, "ms-auto")}
                  >
                    <option value="review">{t("modeReview")}</option>
                    <option value="auto">{t("modeAuto")}</option>
                  </select>
                </div>
                {i === 0 ? (
                  <Input
                    value={step.subject}
                    maxLength={MAX_STEP_SUBJECT}
                    aria-label={t("subject")}
                    placeholder={t("subject")}
                    onChange={(e) => setStep(step.key, { subject: e.target.value })}
                    className="mb-2"
                  />
                ) : (
                  <p className="mb-2 text-xs text-fg-faint">{t("replyHint")}</p>
                )}
                <textarea
                  ref={(el) => {
                    fields.current.set(step.key, el);
                  }}
                  rows={5}
                  value={step.text}
                  maxLength={MAX_STEP_TEXT}
                  aria-label={t("text")}
                  placeholder={t("textPlaceholder", { example: "{{Contact person | there}}" })}
                  onChange={(e) => setStep(step.key, { text: e.target.value })}
                  className={textareaClass}
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="me-1 text-xs text-fg-faint">{t("insert")}</span>
                  {names.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => insert(step, v)}
                      className="h-6 rounded-md border border-border px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={steps.length >= MAX_SEQUENCE_STEPS}
            onClick={() => setSteps((list) => [...list, { key: newKey(), id: null, days: "3", subject: "", text: "", mode: list.at(-1)?.mode ?? "review" }])}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addEmail")}
          </Button>
          <p className="mt-1 text-xs text-fg-faint">{t("variablesHelp", { example: "{{Contact person | there}}" })}</p>
        </div>

        <div className="border-t border-border pt-4">
          <p className="mb-1 text-xs font-medium text-fg-muted">{t("window")}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            {WEEK.map((d) => (
              <label key={d} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--color-accent)]"
                  checked={sendWindow.days.includes(d)}
                  onChange={(e) =>
                    setSendWindow((w) => ({ ...w, days: e.target.checked ? [...w.days, d].sort((a, b) => a - b) : w.days.filter((x) => x !== d) }))
                  }
                />
                {weekday(d)}
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0">
              <Input
                type="time"
                value={clock(sendWindow.start)}
                aria-label={t("windowStart")}
                onChange={(e) => {
                  const m = minutesOf(e.target.value);
                  if (m !== null) setSendWindow((w) => ({ ...w, start: m }));
                }}
              />
            </span>
            <span className="text-fg-muted">–</span>
            <span className="w-28 shrink-0">
              <Input
                type="time"
                value={clock(sendWindow.end)}
                aria-label={t("windowEnd")}
                onChange={(e) => {
                  const m = minutesOf(e.target.value);
                  if (m !== null) setSendWindow((w) => ({ ...w, end: m }));
                }}
              />
            </span>
          </div>
          <p className="mt-1 text-xs text-fg-faint">{t("windowHelp")}</p>
        </div>
      </DialogBody>

      <DialogFooter>
        {shown && (
          <p role="alert" className="me-auto text-xs text-danger">
            {shown}
          </p>
        )}
        {saved && (
          <Button variant="ghost" disabled={pending} onClick={remove} className={cn(!shown && "me-auto", "text-danger hover:text-danger")}>
            {tc("delete")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" disabled={pending} onClick={save}>
          {pending ? tc("saving") : tc("save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * On a connected mailbox: how many follow-up emails it sends a day at most, every follow-up
 * together, and the time zone their send windows read in.
 */
export function MailboxSending({ workspaceId, mailbox, onChange }: { workspaceId: string; mailbox: MailboxView; onChange: (mailbox: MailboxView) => void }) {
  const t = useTranslations("settings.followUps");
  const tc = useTranslations("common");
  const [limit, setLimit] = useState(String(mailbox.followUpDailyLimit));
  const [zone, setZone] = useState(mailbox.timeZone);
  const { pending, error, run } = useAction();
  const zones = useMemo(() => listTimeZones(mailbox.timeZone), [mailbox.timeZone]);
  const value = Number(limit);
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_DAILY_LIMIT;
  const dirty = value !== mailbox.followUpDailyLimit || zone !== mailbox.timeZone;
  const here = browserTimeZone();
  return (
    <SettingsRow
      title={t("dailyLimit")}
      htmlFor={`follow-up-limit-${workspaceId}`}
      description={
        <>
          {t("dailyLimitHelp", { max: MAX_DAILY_LIMIT })}
          {zone !== here && (
            <>
              {" "}
              <button type="button" className="text-fg underline underline-offset-2 hover:text-accent" onClick={() => setZone(here)}>
                {t("useZone", { zone: timeZoneLabel(here) })}
              </button>
            </>
          )}
          {error && <span className="block text-danger">{error}</span>}
        </>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-20 shrink-0">
            <Input
              id={`follow-up-limit-${workspaceId}`}
              type="number"
              min={1}
              max={MAX_DAILY_LIMIT}
              value={limit}
              aria-invalid={!valid}
              onChange={(e) => setLimit(e.target.value)}
            />
          </span>
          <select value={zone} aria-label={t("timeZone")} onChange={(e) => setZone(e.target.value)} className={cn(selectClass, "w-48")}>
            {zones.zones.map((z) => (
              <option key={z} value={z}>
                {timeZoneLabel(z)}
              </option>
            ))}
          </select>
          {dirty && (
            <Button size="sm" variant="primary" disabled={!valid || pending} onClick={() => run(() => setMailboxSendingAction(workspaceId, { dailyLimit: value, timeZone: zone }), onChange)}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          )}
        </div>
      }
    />
  );
}

"use client";

import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleSlash,
  Gauge,
  RefreshCw,
  Search,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAutomationRunsAction, testAutomationAction } from "@/app/actions/automations";
import { Button, cn, IconButton, textareaClass } from "@/components/ui";
import { APPROVAL_TEST_CODE, hasRow, waitingApproval, type AutomationStep } from "@/lib/automations";
import { pageLabel } from "@/lib/labels";
import { searchFold } from "@/lib/search-fold";
import { useDatabaseInfo, useReloadDatabase } from "./automations-data";
import { parseJson, type Automation, type AutomationRun, type DraftTrigger } from "./automations-shared";

/** How often a test run is looked at while it goes, and for how long at most. */
const POLL_MS = 1500;
const POLL_FOR_MS = 60_000;
/** Runs still going are looked at again this often while the history is open. */
const REFRESH_MS = 2500;
const MAX_ROW_CHOICES = 8;

/** Step codes the history explains in words; others show as they are. */
const STEP_CODES = [
  "dependencyFailed",
  "rowsFailed",
  "invalidUrl",
  "blocked",
  "timeout",
  "http",
  "emptyFilter",
  "emptyMatch",
  "noAccess",
  "databaseGone",
  "propertyDeleted",
  "webhookExportOff",
  "invalidHeader",
  "redirect",
  "unreachable",
  "changed",
  "tooManyAttempts",
  "disabled",
  "rowGone",
  "alreadyEnrolled",
  "sequenceGone",
  "noMailbox",
  "noAddress",
  "emailOff",
  "noApprovers",
  "rejected",
  "timedOut",
  "noPerson",
  "tooLate",
  "templateGone",
] as const;

/** A run waits for a wait step: the time it goes on. */
function waitingUntil(run: AutomationRun) {
  if (run.status !== "pending") return null;
  const step = run.steps.find((s) => s.status === "pending" && s.waitUntil);
  return step?.waitUntil && Date.parse(step.waitUntil) > Date.now() ? step.waitUntil : null;
}

/** Whether a run is still going (and not just waiting on purpose: a wait step, an approval). */
const going = (run: AutomationRun) => run.status === "running" || (run.status === "pending" && !waitingUntil(run) && !waitingApproval(run.steps));

function useDuration() {
  const format = useFormatter();
  return (ms: number) =>
    ms < 1000
      ? format.number(ms, { style: "unit", unit: "millisecond", unitDisplay: "short" })
      : ms < 60_000
        ? format.number(ms / 1000, { style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 1 })
        : format.number(ms / 60_000, { style: "unit", unit: "minute", unitDisplay: "short", maximumFractionDigits: 1 });
}

/** JSON as the history shows it, in a box that scrolls. */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      {label && <p className="mb-0.5 text-xs text-fg-muted">{label}</p>}
      <pre dir="ltr" className="max-h-56 overflow-auto rounded-md border border-border bg-bg-hover px-2.5 py-2 text-xs break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

/**
 * The automation's latest runs, newest first: what started each (a row, the schedule, a request),
 * the version it ran, and how each step went, with what it was given and what it gave.
 */
export function RunList({
  workspaceId,
  automation,
  isOwner,
  focus,
}: {
  workspaceId: string;
  automation: Automation;
  isOwner: boolean;
  /** A run to open (a test run just started). */
  focus: string | null;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAutomationRunsAction(automation.id, 20);
      if (res.ok) {
        setRuns(res.data);
        setError(null);
      } else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setLoading(false);
    }
  }, [automation.id, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  // Runs that are still going are looked at again until they end.
  const live = runs?.some(going) ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  if (!runs) {
    return (
      <p className="px-5 py-6 text-sm text-fg-muted" role={error ? "alert" : undefined}>
        {error ?? tc("loading")}
      </p>
    );
  }
  return (
    <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
      <div className="flex items-center justify-between gap-2 pb-1">
        <p className="text-xs text-fg-muted">{t("runs.help")}</p>
        <IconButton label={t("runs.refresh")} onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="pb-2 text-xs text-danger">
          {error}
        </p>
      )}
      {runs.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <RunItem key={run.id} workspaceId={workspaceId} automation={automation} run={run} isOwner={isOwner} initiallyOpen={run.id === focus} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunItem({
  workspaceId,
  automation,
  run,
  isOwner,
  initiallyOpen,
}: {
  workspaceId: string;
  automation: Automation;
  run: AutomationRun;
  isOwner: boolean;
  initiallyOpen: boolean;
}) {
  const t = useTranslations("database.automations.runs");
  const tc = useTranslations("common");
  const format = useFormatter();
  const duration = useDuration();
  const [open, setOpen] = useState(initiallyOpen);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (initiallyOpen) ref.current?.scrollIntoView({ block: "nearest" });
  }, [initiallyOpen]);
  const until = waitingUntil(run);
  const asking = run.status === "pending" ? waitingApproval(run.steps) : null;
  const failed = run.status === "failed";
  const time = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  // A day as a day; a time (or when a row was added or edited) with its time, in the viewer's zone.
  const basisLabel = (basis: string) =>
    basis.length === 10 ? format.dateTime(new Date(`${basis}T00:00:00`), { dateStyle: "medium" }) : time(basis);
  const took = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : null;
  const scheduledFor = run.event === "schedule" ? (run.trigger as { scheduledFor?: string | null } | null)?.scheduledFor : null;
  const crossed = run.event === "threshold.crossed" ? (run.trigger as { value?: number | null; threshold?: number | null; comparison?: string | null } | null) : null;
  const what =
    run.event === "schedule"
      ? t("schedule")
      : crossed
        ? typeof crossed.value === "number" && typeof crossed.threshold === "number"
          ? t("thresholdCrossed", { comparison: crossed.comparison ?? "above", threshold: format.number(crossed.threshold), value: format.number(crossed.value) })
          : t("threshold")
      : run.event === "webhook.received"
        ? t("webhookReceived")
        : run.event === "row.button_clicked"
          ? t("buttonClicked")
          : run.event === "row.meeting_summarized"
            ? t("meetingSummarized")
          : run.basis !== null
            ? t("datePassed", { date: basisLabel(run.basis) })
            : run.event === "row.created"
              ? t("added")
              : t("changed");

  return (
    <li ref={ref} className="py-2.5">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t("hideDetails") : t("showDetails")}
          onClick={() => setOpen(!open)}
          className="mt-0.5 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {run.rowId ? (
              <Link href={`/w/${workspaceId}/p/${run.rowId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                {pageLabel(run.rowTitle, tc("untitled"))}
              </Link>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                {run.event === "schedule" ? (
                  <CalendarClock aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                ) : crossed ? (
                  <Gauge aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                ) : (
                  <Webhook aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                )}
                <span className="truncate">{what}</span>
              </span>
            )}
            {run.test && <Badge>{t("test")}</Badge>}
            {run.draft ? <Badge>{t("draftVersion")}</Badge> : run.version > 0 && <Badge>{t("version", { version: run.version })}</Badge>}
            <span className={cn("shrink-0 text-xs", failed ? "text-danger" : "text-fg-muted")}>
              {until ? t("waitingUntil", { time: time(until) }) : asking ? t("waitingApproval") : t(`status.${run.status}`)}
            </span>
          </div>
          <div className="text-xs text-fg-faint">
            {run.rowId ? `${what} · ` : ""}
            {time(run.createdAt)}
            {took !== null && ` · ${t("took", { time: duration(took) })}`}
          </div>
          {!open && <StepSummary run={run} />}
        </div>
      </div>
      {open && (
        <div className="mt-2 ms-6 space-y-2">
          {scheduledFor && <p className="text-xs text-fg-muted">{t("scheduledFor", { time: time(scheduledFor) })}</p>}
          {run.event === "webhook.received" && run.trigger !== null && <Expandable label={t("payload")} value={run.trigger} />}
          <ol className="ms-1.5 space-y-2 border-s border-border ps-3">
            {run.steps.map((step, i) => (
              <StepItem key={`${step.id ?? i}`} workspaceId={workspaceId} automation={automation} step={step} index={i} isOwner={isOwner} />
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-4 text-fg-muted">{children}</span>;
}

/** The steps in one line: their ids and how each went. */
function StepSummary({ run }: { run: AutomationRun }) {
  const t = useTranslations("database.automations");
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
      {run.steps.map((step, i) => (
        <li key={`${step.id ?? i}`} className="flex items-center gap-1" title={step.error}>
          <StepIcon status={step.status} />
          <span>{step.id ?? t(`form.actionType.${step.type}`)}</span>
        </li>
      ))}
    </ul>
  );
}

function StepIcon({ status }: { status: AutomationStep["status"] }) {
  const Icon = status === "done" ? CircleCheck : status === "failed" ? CircleAlert : status === "skipped" ? CircleMinus : status === "stopped" ? CircleSlash : CircleDashed;
  return <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", status === "failed" ? "text-danger" : status === "done" ? "text-fg-muted" : "text-fg-faint")} />;
}

/** A toggle that shows a JSON value under it. */
function Expandable({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded text-xs text-fg-muted hover:text-fg"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
        {label}
      </button>
      {open && (
        <div className="mt-1">
          <JsonBlock label="" value={value} />
        </div>
      )}
    </div>
  );
}

/** One step of a run: its id and type, how it went and how long it took, why it failed, and what it was given and gave. */
function StepItem({
  workspaceId,
  automation,
  step,
  index,
  isOwner,
}: {
  workspaceId: string;
  automation: Automation;
  step: AutomationStep;
  index: number;
  isOwner: boolean;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const format = useFormatter();
  const duration = useDuration();
  const [open, setOpen] = useState(step.status === "failed");
  const hasDetail = step.input !== undefined || step.output !== undefined || (step.items?.length ?? 0) > 0;
  // An approval says how it was answered in its own line; its code would only repeat it.
  const coded = step.type === "approval" && step.approval ? undefined : step.code;
  const code = coded && (STEP_CODES as readonly string[]).includes(coded) ? t(`runs.code.${coded as (typeof STEP_CODES)[number]}`) : coded;
  const agentRuns = step.agentRunIds?.length ? step.agentRunIds : step.agentRunId ? [step.agentRunId] : [];

  return (
    <li className="text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <StepIcon status={step.status} />
        {step.id && <span className="font-medium">{step.id}</span>}
        <span className="text-fg-muted">{t(`form.actionType.${step.type}`)}</span>
        <span className={cn("text-xs", step.status === "failed" ? "text-danger" : "text-fg-muted")}>
          · {step.status === "pending" && step.waitUntil ? t("runs.waitsUntil", { time: format.dateTime(new Date(step.waitUntil), { dateStyle: "medium", timeStyle: "short" }) }) : t(`runs.stepStatus.${step.status}`)}
        </span>
        {step.durationMs !== undefined && step.status !== "pending" && <span className="text-xs text-fg-faint">· {duration(step.durationMs)}</span>}
        {step.attempts > 1 && <span className="text-xs text-fg-faint">· {t("runs.attempts", { count: step.attempts })}</span>}
        {step.httpStatus ? <span className="text-xs text-fg-faint">· HTTP {step.httpStatus}</span> : null}
        {step.type === "notify" && step.notified !== undefined && <span className="text-xs text-fg-faint">· {t("runs.notified", { count: step.notified })}</span>}
      </div>
      {step.approval && <ApprovalLine step={step} />}
      {(code || step.error) && (
        <p className={cn("mt-0.5 text-xs break-words", step.status === "failed" ? "text-danger" : "text-fg-muted")}>
          {code}
          {code && step.error && code !== step.error ? ": " : ""}
          {step.error && step.error !== code ? <span className={step.status === "failed" ? "text-fg-muted" : undefined}>{step.error}</span> : null}
        </p>
      )}
      {agentRuns.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
          {agentRuns.map((runId, n) => (
            <AgentRunLink
              key={runId}
              workspaceId={workspaceId}
              automation={automation}
              stepId={step.id}
              index={index}
              runId={runId}
              isOwner={isOwner}
              n={agentRuns.length > 1 ? n + 1 : null}
            />
          ))}
        </div>
      )}
      {hasDetail && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-0.5 inline-flex items-center gap-1 rounded text-xs text-fg-muted hover:text-fg"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
          {t("runs.details")}
        </button>
      )}
      {open && hasDetail && (
        <div className="mt-1 space-y-1.5">
          {step.items && step.items.length > 0 && (
            <div>
              <p className="mb-0.5 text-xs text-fg-muted">{t("runs.items", { count: step.items.length })}</p>
              <ul className="space-y-0.5">
                {step.items.map((item) => (
                  <li key={item.rowId} className="flex min-w-0 items-baseline gap-1.5 text-xs">
                    <StepIcon status={item.status} />
                    <Link href={`/w/${workspaceId}/p/${item.rowId}`} className="min-w-0 truncate hover:underline">
                      {pageLabel(item.title, tc("untitled"))}
                    </Link>
                    {item.error && <span className="min-w-0 truncate text-danger" title={item.error}>{item.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {step.input !== undefined && <JsonBlock label={t("runs.input")} value={step.input} />}
          {step.output !== undefined && <JsonBlock label={t("runs.output")} value={step.output} />}
        </div>
      )}
    </li>
  );
}

/**
 * How an approval step stands: whom it asks and until when, who approved or rejected it and when,
 * that nobody answered in time (and whether the run went on), or, in a test run, whom it would ask.
 */
function ApprovalLine({ step }: { step: AutomationStep }) {
  const t = useTranslations("database.automations.runs.approval");
  const format = useFormatter();
  const approval = step.approval!;
  const time = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const names = format.list(approval.approvers.map((a) => a.name || "?"), { type: "disjunction" });
  let text: string;
  if (approval.test || step.code === APPROVAL_TEST_CODE) text = t("wouldAsk", { names });
  else if (approval.answer === "approved") text = t("approved", { name: approval.answeredBy?.name || "?", time: time(approval.answeredAt ?? approval.expiresAt) });
  else if (approval.answer === "rejected") text = t("rejected", { name: approval.answeredBy?.name || "?", time: time(approval.answeredAt ?? approval.expiresAt) });
  else if (approval.answer === "timedOut") text = step.status === "done" ? t("timedOutContinued", { time: time(approval.expiresAt) }) : t("timedOut", { time: time(approval.expiresAt) });
  else if (step.status === "pending") text = t("waiting", { names, time: time(approval.expiresAt) });
  else text = t("closed", { names });
  return <p className={cn("mt-0.5 text-xs", approval.answer === "rejected" ? "text-fg" : "text-fg-muted")}>{text}</p>;
}

/** Where a "Run an agent" step's run is: the agent's runs in Settings (owners), else a hint. */
function AgentRunLink({
  workspaceId,
  automation,
  stepId,
  index,
  runId,
  isOwner,
  n,
}: {
  workspaceId: string;
  automation: Automation;
  stepId: string | undefined;
  index: number;
  runId: string;
  isOwner: boolean;
  /** Which of a "for each" step's runs. */
  n: number | null;
}) {
  const t = useTranslations("database.automations.runs");
  // The step by its id in the published steps or the draft; else by where it was; else the first agent step.
  const steps = [...automation.actions, ...(automation.draft?.actions ?? [])];
  const action =
    steps.find((a) => a.type === "run_agent" && stepId && a.id === stepId) ??
    (automation.actions[index]?.type === "run_agent" ? automation.actions[index] : steps.find((a) => a.type === "run_agent"));
  if (!isOwner || action?.type !== "run_agent") return n === null || n === 1 ? <span className="text-fg-muted">{t("agentRunHint")}</span> : null;
  return (
    <Link
      href={`/w/${workspaceId}/settings?tab=agents&agent=${encodeURIComponent(action.agentId)}&run=${encodeURIComponent(runId)}`}
      className="text-fg underline underline-offset-2 hover:text-accent"
    >
      {n === null ? t("agentRun") : t("agentRunN", { n })}
    </Link>
  );
}

/**
 * A test run: of a row trigger on a row picked here, of an incoming webhook with a body (the
 * example to start with), of a schedule as if it came round. It really does its steps. Once
 * started it is looked at until it ends (or waits), at most a minute, then shown in the history.
 */
export function TestRunPanel({
  automationId,
  databaseId,
  trigger,
  prepare,
  onDone,
  onCancel,
}: {
  automationId: string | null;
  databaseId: string;
  /** The trigger as edited (saved before the run starts). */
  trigger: DraftTrigger;
  /** Saves unsaved changes as the draft; the automation's id, or null when it couldn't be saved. */
  prepare: () => Promise<string | null>;
  onDone: (automationId: string, runId: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("database.automations.test");
  const tc = useTranslations("common");
  const row = hasRow(trigger);
  const info = useDatabaseInfo(row ? databaseId : null);
  const reload = useReloadDatabase();
  const [query, setQuery] = useState("");
  const [rowId, setRowId] = useState<string | null>(null);
  const [payload, setPayload] = useState(() => (trigger.type === "incoming_webhook" && trigger.example.trim() ? trigger.example : "{}"));
  const [state, setState] = useState<"idle" | "starting" | "running">("idle");
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    // Rows added since the dialog opened are offered too.
    if (row) reload(databaseId);
  }, [row, databaseId, reload]);

  const rows = useMemo(() => {
    const q = searchFold(query.trim());
    return (info?.rows ?? []).filter((r) => !q || searchFold(pageLabel(r.title, "")).includes(q)).slice(0, MAX_ROW_CHOICES);
  }, [info, query]);
  const chosen = info?.rows.find((r) => r.id === rowId);
  const body = parseJson(payload);

  const start = async () => {
    setError(null);
    setState("starting");
    const id = await prepare();
    if (!id || !live.current) {
      setState("idle");
      return;
    }
    try {
      const res = await testAutomationAction(id, row ? { rowId } : trigger.type === "incoming_webhook" ? { payload: body.ok ? (body.value ?? {}) : {} } : {});
      if (!res.ok) {
        setError(res.error);
        setState("idle");
        return;
      }
      setState("running");
      const runId = res.data.runId;
      const until = Date.now() + POLL_FOR_MS;
      // Looked at until it ends, waits for a wait step, or a minute has gone by.
      while (live.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const runs = await listAutomationRunsAction(id, 20).catch(() => null);
        const run = runs?.ok ? runs.data.find((r) => r.id === runId) : undefined;
        if (run && !going(run)) break;
      }
      if (live.current) onDone(id, runId);
    } catch {
      setError(tc("genericError"));
      setState("idle");
    }
  };

  const ready = state === "idle" && (row ? !!rowId : trigger.type === "incoming_webhook" ? body.ok : true);
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">{t("title")}</p>
      {row ? (
        <div>
          <p className="mb-1 text-xs text-fg-muted">{t("chooseRow")}</p>
          <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
            <Search className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchRows")}
              aria-label={t("searchRows")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </label>
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border p-1" role="listbox" aria-label={t("chooseRow")}>
            {info === undefined && <li className="px-2 py-1.5 text-sm text-fg-muted">{tc("loading")}</li>}
            {info !== undefined && !rows.length && <li className="px-2 py-1.5 text-sm text-fg-muted">{t("noRows")}</li>}
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={r.id === rowId}
                  onClick={() => setRowId(r.id)}
                  className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover", r.id === rowId && "bg-bg-hover")}
                >
                  <span className="min-w-0 flex-1 truncate">{pageLabel(r.title, tc("untitled"))}</span>
                  {r.id === rowId && <CircleCheck className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </button>
              </li>
            ))}
          </ul>
          {chosen && <p className="mt-1 text-xs text-fg-muted">{t("chosenRow", { title: pageLabel(chosen.title, tc("untitled")) })}</p>}
        </div>
      ) : trigger.type === "incoming_webhook" ? (
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("payload")}</span>
          <textarea
            rows={5}
            dir="ltr"
            spellCheck={false}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            className={cn(textareaClass, "text-xs", !body.ok && "border-danger focus:border-danger")}
          />
          {!body.ok && <span className="mt-1 block text-xs text-danger">{t("payloadInvalid")}</span>}
        </label>
      ) : (
        <p className="text-xs text-fg-muted">{t(trigger.type === "view_threshold" ? "threshold" : "schedule")}</p>
      )}
      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("realEffects")}
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {state === "running" && (
          <span className="me-auto text-xs text-fg-muted" role="status">
            {t("running")}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={state !== "idle"}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" size="sm" disabled={!ready} onClick={() => void start()}>
          {state === "idle" ? (automationId ? t("run") : t("saveAndRun")) : t("starting")}
        </Button>
      </div>
    </div>
  );
}

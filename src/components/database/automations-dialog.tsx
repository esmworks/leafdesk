"use client";

import { ArrowLeft, History, Pencil, Plus, Trash2, X, Zap } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteAutomationAction,
  listAutomationRunsAction,
  listAutomationsAction,
  updateAutomationAction,
} from "@/app/actions/automations";
import { Button, cn, Dialog, IconButton, Switch } from "@/components/ui";
import { MAX_AUTOMATIONS } from "@/lib/automations";
import { browserTimeZone, timeZoneLabel } from "@/lib/time-zone";
import { AutomationEditor, Footer } from "./automations-editor";
import { triggerValueName, type AgentChoice, type Automation, type AutomationRun, type Person } from "./automations-shared";
import { usePeople } from "./person-cell";
import { useSchema } from "./schema-context";

/**
 * The database toolbar's automations button: "when a row is added or a property changes, set
 * values, notify people or call a webhook". Shown to people with full access to the database.
 */
export function AutomationsButton({
  workspaceId,
  databaseId,
  databaseTitle,
}: {
  workspaceId: string;
  databaseId: string;
  databaseTitle: string;
}) {
  const t = useTranslations("database.automations");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={t("button")}
        aria-label={t("button")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <Zap className="h-4 w-4" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        // A portal keeps the toolbar's styles out; React context (schema, people) still reaches it.
        createPortal(
          <AutomationsDialog
            workspaceId={workspaceId}
            databaseId={databaseId}
            databaseTitle={databaseTitle}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

type Mode = { kind: "list" } | { kind: "edit"; id: string | null } | { kind: "runs"; id: string };

function AutomationsDialog({
  workspaceId,
  databaseId,
  databaseTitle,
  onClose,
}: {
  workspaceId: string;
  databaseId: string;
  databaseTitle: string;
  onClose: () => void;
}) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const { people: databasePeople } = usePeople();
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [members, setMembers] = useState<Person[]>([]);
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  useEffect(() => {
    let live = true;
    listAutomationsAction(databaseId)
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        setAutomations(res.data.automations);
        setMembers(res.data.members);
        setAgents(res.data.agents);
        setIsOwner(res.data.isOwner);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [databaseId, tc]);

  // The workspace's people; guests can't list them and get the ones the database knows instead.
  const people = useMemo<Person[]>(
    () => (members.length ? members : databasePeople.filter((p) => p.active)),
    [members, databasePeople],
  );

  const replace = (next: Automation) => setAutomations((list) => (list ?? []).map((a) => (a.id === next.id ? next : a)));

  const toggle = async (automation: Automation, enabled: boolean) => {
    setError(null);
    replace({ ...automation, enabled });
    try {
      // Turning it on or off saves it too: it runs as, and counts days in the time zone of, whoever did.
      const res = await updateAutomationAction(automation.id, { enabled, timeZone: browserTimeZone() });
      if (res.ok) replace(res.data);
      else {
        replace(automation);
        setError(res.error);
      }
    } catch {
      replace(automation);
      setError(tc("genericError"));
    }
  };

  const remove = async (automation: Automation) => {
    if (!confirm(t("confirmDelete", { name: automation.name }))) return;
    setError(null);
    try {
      const res = await deleteAutomationAction(automation.id);
      if (res.ok) setAutomations((list) => (list ?? []).filter((a) => a.id !== automation.id));
      else setError(res.error);
    } catch {
      setError(tc("genericError"));
    }
  };

  const current = mode.kind !== "list" && mode.id ? automations?.find((a) => a.id === mode.id) ?? null : null;
  const full = (automations?.length ?? 0) >= MAX_AUTOMATIONS;

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {mode.kind !== "list" && (
          <IconButton label={t("back")} onClick={() => setMode({ kind: "list" })} className="mt-1">
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {mode.kind === "list"
              ? t("title")
              : mode.kind === "runs"
                ? t("runs.title")
                : current
                  ? t("editTitle")
                  : t("new")}
          </h2>
          <p className="mt-0.5 truncate text-sm text-fg-muted">
            {mode.kind !== "list" && current ? current.name : databaseTitle || tc("untitled")}
          </p>
        </div>
        <button
          type="button"
          aria-label={tc("close")}
          title={tc("close")}
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!automations ? (
        <p className="px-5 py-6 text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : mode.kind === "edit" ? (
        <AutomationEditor
          key={current?.id ?? "new"}
          workspaceId={workspaceId}
          databaseId={databaseId}
          saved={current}
          people={people}
          agents={agents}
          isOwner={isOwner}
          onCancel={() => setMode({ kind: "list" })}
          onUpdated={replace}
          onSaved={(saved, created) => {
            setAutomations((list) => (created ? [...(list ?? []), saved] : (list ?? []).map((a) => (a.id === saved.id ? saved : a))));
            // A new webhook's signing secret shows once it is saved: stay so it can be copied.
            if (created && saved.secret) setMode({ kind: "edit", id: saved.id });
            else setMode({ kind: "list" });
          }}
        />
      ) : mode.kind === "runs" && current ? (
        <RunList workspaceId={workspaceId} automation={current} isOwner={isOwner} />
      ) : (
        <>
          <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
            {automations.length === 0 ? (
              <p className="py-3 text-sm text-fg-muted">{t("empty")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {automations.map((automation) => (
                  <AutomationItem
                    key={automation.id}
                    automation={automation}
                    people={people}
                    agents={agents}
                    onToggle={(enabled) => void toggle(automation, enabled)}
                    onEdit={() => setMode({ kind: "edit", id: automation.id })}
                    onRuns={() => setMode({ kind: "runs", id: automation.id })}
                    onDelete={() => void remove(automation)}
                  />
                ))}
              </ul>
            )}
          </div>
          <Footer error={error}>
            <Button
              variant="primary"
              disabled={full}
              title={full ? t("tooMany", { max: MAX_AUTOMATIONS }) : undefined}
              onClick={() => setMode({ kind: "edit", id: null })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("new")}
            </Button>
          </Footer>
        </>
      )}
    </Dialog>
  );
}

function AutomationItem({
  automation,
  people,
  agents,
  onToggle,
  onEdit,
  onRuns,
  onDelete,
}: {
  automation: Automation;
  people: Person[];
  agents: AgentChoice[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRuns: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("database.automations");
  const format = useFormatter();
  const summary = useSummary(automation, people, agents);
  const last = automation.lastRun;
  return (
    <li className="flex items-center gap-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm font-medium", !automation.enabled && "text-fg-muted")}>{automation.name}</div>
        <div className="truncate text-xs text-fg-muted" title={summary}>
          {summary}
        </div>
        <div className={cn("text-xs", last?.status === "failed" ? "text-danger" : "text-fg-faint")}>
          {last
            ? t("lastRun", {
                status: t(`runs.status.${last.status}`),
                time: format.dateTime(new Date(last.at), { dateStyle: "medium", timeStyle: "short" }),
              })
            : t("neverRun")}
        </div>
        {automation.checkError && <div className="text-xs text-danger">{t(`checkError.${automation.checkError}`)}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={t("runs.title")} onClick={onRuns}>
          <History className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t("edit")} onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t("delete")} onClick={onDelete} className="hover:text-danger">
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
        <span className="ml-1.5">
          <Switch checked={automation.enabled} label={t("toggle", { name: automation.name })} onChange={onToggle} />
        </span>
      </div>
    </li>
  );
}

/** "When Status becomes Done → Set Date, Notify, Webhook, Run Ticket router". */
function useSummary(automation: Automation, people: Person[], agents: AgentChoice[]) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const nameOf = (id: string) => properties.find((p) => p.id === id)?.name ?? t("deletedProperty");
  const tGroup = useTranslations("database.statusGroups");
  const { trigger } = automation;
  let when: string;
  if (trigger.type === "row_created") when = t("summaryTrigger.rowCreated");
  else if (trigger.type === "date_passed") {
    when =
      trigger.date === "created_time" || trigger.date === "last_edited_time"
        ? t("summaryTrigger.datePassedSince", {
            days: trigger.days,
            date: t(trigger.date === "created_time" ? "summaryTrigger.rowAdded" : "summaryTrigger.lastEdited"),
          })
        : t("summaryTrigger.datePassedProperty", { days: trigger.days, date: nameOf(trigger.date) });
    // A date property's days count in the saver's time zone: worth saying when it isn't the viewer's.
    const dated = trigger.date !== "created_time" && trigger.date !== "last_edited_time";
    if (dated && automation.timeZone !== browserTimeZone()) {
      when = t("summaryTrigger.inZone", { trigger: when, zone: timeZoneLabel(automation.timeZone) });
    }
    if (trigger.status) {
      when = t("summaryTrigger.withStatus", { trigger: when, groups: trigger.status.groups.map((g) => tGroup(g)).join(", ") });
    }
  } else if (trigger.propertyId === null) when = t("summaryTrigger.anyChange");
  else {
    const prop = properties.find((p) => p.id === trigger.propertyId);
    const value = triggerValueName(trigger, prop, people, { checked: t("checked"), unchecked: t("unchecked") });
    when =
      value === null
        ? t("summaryTrigger.changes", { property: nameOf(trigger.propertyId) })
        : t("summaryTrigger.becomes", { property: nameOf(trigger.propertyId), value });
  }
  const actions = automation.actions
    .map((action) =>
      action.type === "set_properties"
        ? t("summaryAction.set", { properties: Object.keys(action.values).map(nameOf).join(", ") })
        : action.type === "notify"
          ? t("summaryAction.notify")
          : action.type === "run_agent"
            ? t("summaryAction.runAgent", { agent: agents.find((a) => a.id === action.agentId)?.name ?? t("summaryAction.archivedAgent") })
            : action.type === "move_to_trash"
              ? t("summaryAction.trash")
              : t("summaryAction.webhook"),
    )
    .join(", ");
  return t("summary", { trigger: when, actions });
}

/**
 * The automation's latest runs: which row, when, and how each step went. A "Run an agent" step
 * links owners to the agent's own run, where what it did is.
 */
function RunList({ workspaceId, automation, isOwner }: { workspaceId: string; automation: Automation; isOwner: boolean }) {
  const t = useTranslations("database.automations");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  // A day as a day; a time (or when a row was added or edited) with its time, in the viewer's zone.
  const basisLabel = (basis: string) =>
    basis.length === 10
      ? format.dateTime(new Date(`${basis}T00:00:00`), { dateStyle: "medium" })
      : format.dateTime(new Date(basis), { dateStyle: "medium", timeStyle: "short" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listAutomationRunsAction(automation.id, 20)
      .then((res) => {
        if (!live) return;
        if (res.ok) setRuns(res.data);
        else setError(res.error);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [automation.id, tc]);

  if (!runs) {
    return (
      <p className="px-5 py-6 text-sm text-fg-muted" role={error ? "alert" : undefined}>
        {error ?? tc("loading")}
      </p>
    );
  }
  return (
    <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
      {runs.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <li key={run.id} className="py-2.5">
              <div className="flex items-baseline gap-2">
                <Link href={`/w/${workspaceId}/p/${run.rowId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                  {run.rowTitle || tc("untitled")}
                </Link>
                <span className={cn("shrink-0 text-xs", run.status === "failed" ? "text-danger" : "text-fg-muted")}>
                  {t(`runs.status.${run.status}`)}
                </span>
              </div>
              <div className="text-xs text-fg-faint">
                {run.basis !== null
                  ? t("runs.datePassed", { date: basisLabel(run.basis) })
                  : run.event === "row.created"
                    ? t("runs.added")
                    : t("runs.changed")}{" "}
                ·{" "}
                {format.dateTime(new Date(run.createdAt), { dateStyle: "medium", timeStyle: "short" })}
              </div>
              <ul className="mt-1 space-y-0.5">
                {run.steps.map((step, i) => (
                  <li key={i} className="flex flex-wrap gap-x-1.5 text-xs text-fg-muted" title={step.error}>
                    <span>{t(`form.actionType.${step.type}`)}:</span>
                    <span className={cn(step.status === "failed" && "text-danger")}>{t(`runs.stepStatus.${step.status}`)}</span>
                    {step.code && <span>({step.code})</span>}
                    {step.httpStatus ? <span>HTTP {step.httpStatus}</span> : null}
                    {step.type === "notify" && step.notified !== undefined && (
                      <span>{t("runs.notified", { count: step.notified })}</span>
                    )}
                    {step.attempts > 1 && <span>{t("runs.attempts", { count: step.attempts })}</span>}
                    {step.type === "run_agent" && step.agentRunId && (
                      <AgentRunLink workspaceId={workspaceId} automation={automation} index={i} runId={step.agentRunId} isOwner={isOwner} />
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where a "Run an agent" step's run is: the agent's runs in Settings (owners), else a hint. */
function AgentRunLink({
  workspaceId,
  automation,
  index,
  runId,
  isOwner,
}: {
  workspaceId: string;
  automation: Automation;
  index: number;
  runId: string;
  isOwner: boolean;
}) {
  const t = useTranslations("database.automations.runs");
  // The step's action, when the automation still has it where it was; else its first agent.
  const action = automation.actions[index]?.type === "run_agent" ? automation.actions[index] : automation.actions.find((a) => a.type === "run_agent");
  if (!isOwner || action?.type !== "run_agent") return <span>· {t("agentRunHint")}</span>;
  return (
    <Link
      href={`/w/${workspaceId}/settings?tab=agents&agent=${encodeURIComponent(action.agentId)}&run=${encodeURIComponent(runId)}`}
      className="text-fg underline underline-offset-2 hover:text-accent"
    >
      {t("agentRun")}
    </Link>
  );
}

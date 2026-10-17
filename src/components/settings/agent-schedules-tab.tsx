"use client";

import { CalendarClock, Pencil, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { listAgentSchedulesAction, removeAgentScheduleAction, setAgentScheduleAction } from "@/app/actions/agents";
import { freshRepeatForm, RepeatRuleFields, repeatFormOf, useRepeatRule, type RepeatForm } from "@/components/repeat-rule-fields";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, IconButton, PageIcon, pageLabel, selectClass, textareaClass } from "@/components/ui";
import { MAX_AGENT_SCHEDULES, MAX_SCHEDULE_TASK, MAX_SCHEDULED_WRITES, type AgentScheduleView, type AgentView } from "@/lib/agents";
import { WEEKDAYS_FROM_MONDAY, type RepeatRule } from "@/lib/schedule";
import { timeZoneLabel } from "@/lib/time-zone";
import { useShareablePages } from "./agent-page-picker";

/** `taskHidden`: the task is one the owner can't read (its database is hidden from them); left empty, it is kept. */
type Draft = { id: string | null; repeat: RepeatForm; task: string; taskHidden: boolean; databaseId: string };

const newDraft = (): Draft => ({ id: null, repeat: freshRepeatForm({ frequency: "daily", time: "08:00" }), task: "", taskHidden: false, databaseId: "" });

/**
 * When the agent runs on its own (server/agents/schedules.ts): each schedule's rule, the database
 * it looks after and its task, what stands in its way, and a form to add or change one. Its runs
 * go to the Runs tab, and their reports to the inbox of whoever set the schedule.
 */
export function AgentSchedulesTab({ workspaceId, agent, onRuns }: { workspaceId: string; agent: AgentView; onRuns: () => void }) {
  const t = useTranslations("settings.agents.schedules");
  const tc = useTranslations("common");
  const [schedules, setSchedules] = useState<AgentScheduleView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    listAgentSchedulesAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setSchedules(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  const edit = (s: AgentScheduleView) => setDraft({ id: s.id, repeat: repeatFormOf(s.rule, s.timeZone), task: s.task, taskHidden: s.taskHidden, databaseId: s.databaseId ?? "" });

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      {!agent.enabled && !agent.archived && <p className="text-sm text-fg-muted">{t("agentPaused")}</p>}
      {agent.archived && <p className="text-sm text-fg-muted">{t("archived")}</p>}
      {error && !draft && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!schedules ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          {schedules.length ? (
            <ul aria-label={t("list")} className="divide-y divide-border rounded-md border border-border">
              {schedules.map((s) => (
                <ScheduleItem
                  key={s.id}
                  workspaceId={workspaceId}
                  schedule={s}
                  disabled={pending || agent.archived}
                  editing={draft?.id === s.id}
                  onEdit={() => edit(s)}
                  onRemove={() =>
                    run(() => removeAgentScheduleAction(workspaceId, agent.id, s.id), (next) => {
                      setSchedules(next);
                      if (draft?.id === s.id) setDraft(null);
                    })
                  }
                />
              ))}
            </ul>
          ) : (
            !draft && <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{t("empty")}</p>
          )}
          {schedules.some((s) => s.lastRunAt) && (
            <button type="button" onClick={onRuns} className="text-xs text-fg-muted hover:underline">
              {t("seeRuns")}
            </button>
          )}
          {!agent.archived &&
            (draft ? (
              <ScheduleForm
                workspaceId={workspaceId}
                draft={draft}
                onChange={(change) => setDraft((d) => (d ? { ...d, ...change } : d))}
                pending={pending}
                error={error}
                onCancel={() => setDraft(null)}
                onSave={(value) =>
                  run(() => setAgentScheduleAction(workspaceId, agent.id, draft.id, value), (next) => {
                    setSchedules(next);
                    setDraft(null);
                  })
                }
              />
            ) : (
              schedules.length < MAX_AGENT_SCHEDULES && <Button onClick={() => setDraft(newDraft())}>{t("add")}</Button>
            ))}
        </>
      )}
    </div>
  );
}

/** "Every 2 weeks on Mon, Thu · 08:00 (Europe/Istanbul)", in the viewer's words. */
function useRuleSummary() {
  const t = useTranslations("settings.agents.schedules");
  const tr = useTranslations("database.page.templates.repeatDialog");
  const format = useFormatter();
  return (rule: RepeatRule, timeZone: string) => {
    const how = rule.interval === 1 ? tr(`frequencies.${rule.frequency}`) : t("every", { count: rule.interval, unit: tr(`units.${rule.frequency}`, { count: rule.interval }) });
    const days =
      rule.frequency === "weekly"
        ? WEEKDAYS_FROM_MONDAY.filter((d) => rule.weekdays.includes(d))
            // 2026-10-04 was a Sunday: day 0 of that week.
            .map((d) => format.dateTime(new Date(Date.UTC(2026, 9, 4 + d)), { weekday: "short", timeZone: "UTC" }))
            .join(", ")
        : "";
    const zone = timeZoneLabel(timeZone);
    return days ? t("summaryOn", { how, days, time: rule.time, zone }) : t("summary", { how, time: rule.time, zone });
  };
}

function ScheduleItem({
  workspaceId,
  schedule: s,
  disabled,
  editing,
  onEdit,
  onRemove,
}: {
  workspaceId: string;
  schedule: AgentScheduleView;
  disabled: boolean;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("settings.agents.schedules");
  const tc = useTranslations("common");
  const format = useFormatter();
  const summary = useRuleSummary();
  const when = (at: string) => format.dateTime(new Date(at), { dateStyle: "medium", timeStyle: "short", timeZone: s.timeZone });
  const database = s.databaseId ? (s.databaseTitle !== null ? pageLabel(s.databaseTitle, tc("untitled")) : null) : undefined;

  return (
    <li className={cn("space-y-1 px-3 py-2.5 text-sm", editing && "bg-bg-subtle")}>
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{summary(s.rule, s.timeZone)}</p>
          <p className="text-xs text-fg-muted">
            {database === undefined ? (
              t("noDatabase")
            ) : database === null ? (
              t("databaseHidden")
            ) : (
              <span className="inline-flex items-center gap-1">
                <PageIcon icon={s.databaseIcon} kind="database" className="text-xs" />
                <Link href={`/w/${workspaceId}/p/${s.databaseId}`} className="hover:underline">
                  {database}
                </Link>
              </span>
            )}
            {s.setBy && ` · ${t("setBy", { name: s.setBy.name })}`}
          </p>
        </div>
        <IconButton label={t("edit")} disabled={disabled} onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={t("remove")} disabled={disabled} onClick={onRemove} className="hover:text-danger">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {s.task && <p className="ms-6 line-clamp-2 whitespace-pre-wrap text-fg-muted">{s.task}</p>}
      <div className="ms-6 space-y-0.5 text-xs">
        {s.enabled ? (
          s.nextRunAt && <p className="text-fg-muted">{t("next", { date: when(s.nextRunAt) })}</p>
        ) : (
          <p className="text-danger">{t(`paused.${s.lastError ?? "failed"}`)}</p>
        )}
        {s.enabled && s.lastError === "failed" && <p className="text-fg-muted">{t("lastFailed")}</p>}
        {s.lastRunAt && <p className="text-fg-faint">{t("lastRun", { date: when(s.lastRunAt) })}</p>}
        {(s.agentAccess === "none" || s.agentAccess === "view" || s.agentAccess === "comment") && (
          <p className="flex items-start gap-1 text-fg">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            {t(`access.${s.agentAccess}`)}
          </p>
        )}
      </div>
    </li>
  );
}

function ScheduleForm({
  workspaceId,
  draft,
  onChange,
  pending,
  error,
  onCancel,
  onSave,
}: {
  workspaceId: string;
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (value: { rule: RepeatRule; timeZone: string; task: string | null; databaseId: string | null }) => void;
}) {
  const t = useTranslations("settings.agents.schedules");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { rule, valid, next } = useRepeatRule(draft.repeat);
  // Any database the owner can open: they set the schedule, and its runs are held to their access.
  const pages = useShareablePages(workspaceId, { anyAccess: true });
  const databases = (pages ?? []).filter((p) => p.kind === "database");
  const task = draft.task.trim();
  // A hidden task left empty is kept as it is.
  const keepTask = !task && draft.taskHidden;
  const field = "space-y-1";
  const label = "block text-xs font-medium text-fg-muted";

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!rule || !valid || (!task && !keepTask)) return;
        onSave({ rule, timeZone: draft.repeat.timeZone, task: keepTask ? null : task, databaseId: draft.databaseId || null });
      }}
    >
      <h3 className="text-sm font-medium">{draft.id ? t("editHeading") : t("add")}</h3>
      <RepeatRuleFields form={draft.repeat} onChange={(change) => onChange({ repeat: { ...draft.repeat, ...change } })} idPrefix="agent-schedule" />
      <div className={field}>
        <label htmlFor="agent-schedule-database" className={label}>
          {t("database")}
        </label>
        <select
          id="agent-schedule-database"
          className={cn(selectClass, "w-full")}
          value={draft.databaseId}
          onChange={(e) => onChange({ databaseId: e.target.value })}
        >
          <option value="">{t("noDatabaseOption")}</option>
          {/* The one it looks after now, even when the tree doesn't list it (it's under a page they can't open). */}
          {draft.databaseId && !databases.some((d) => d.id === draft.databaseId) && <option value={draft.databaseId}>{t("databaseHidden")}</option>}
          {databases.map((d) => (
            <option key={d.id} value={d.id}>
              {pageLabel(d.title, tc("untitled"))}
              {d.place ? ` · ${d.place}` : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-fg-faint">{draft.databaseId ? t("databaseHint", { max: MAX_SCHEDULED_WRITES }) : t("noDatabaseHint")}</p>
      </div>
      <div className={field}>
        <label htmlFor="agent-schedule-task" className={label}>
          {t("task")}
        </label>
        <textarea
          id="agent-schedule-task"
          rows={4}
          maxLength={MAX_SCHEDULE_TASK}
          className={textareaClass}
          placeholder={t("taskPlaceholder")}
          value={draft.task}
          onChange={(e) => onChange({ task: e.target.value })}
        />
        {draft.taskHidden && <p className="text-xs text-fg-faint">{t("taskKept")}</p>}
      </div>
      <div className="space-y-0.5 text-sm text-fg-muted" aria-live="polite">
        {next && <p>{t("next", { date: format.dateTime(next, { dateStyle: "full", timeStyle: "short", timeZone: draft.repeat.timeZone }) })}</p>}
        <p className="text-xs text-fg-faint">{t("reportHint")}</p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || (!task && !keepTask) || pending}>
          {pending ? tc("saving") : tc("save")}
        </Button>
      </div>
    </form>
  );
}

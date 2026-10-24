"use client";

import { ArrowLeft, History, Pencil, Plus, Trash2, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteAutomationAction, listAutomationsAction, updateAutomationAction } from "@/app/actions/automations";
import { Button, cn, Dialog, IconButton, Switch } from "@/components/ui";
import { galleryAutomations, type GalleryAutomation } from "@/lib/automation-gallery";
import { MAX_AUTOMATIONS, watchedProperties } from "@/lib/automations";
import { browserTimeZone, timeZoneLabel } from "@/lib/time-zone";
import { DatabasesProvider } from "./automations-data";
import { AutomationEditor, Footer } from "./automations-editor";
import { RunList } from "./automations-runs";
import { FollowUpExampleButton, SequenceChoicesProvider } from "./automations-sequences";
import { toDraft, triggerValueName, type AgentChoice, type Automation, type Draft, type Person } from "./automations-shared";
import { usePeople } from "./person-cell";
import { useSchema } from "./schema-context";

type Mode = { kind: "list" } | { kind: "edit"; id: string | null; start?: Draft } | { kind: "runs"; id: string; focus: string | null };

/**
 * The automations of a database: its list, the editor and each one's runs. Opened from the toolbar's
 * button (automations-button.tsx), which loads this file with the dialog's first opening.
 */
export default function AutomationsDialog({
  workspaceId,
  databaseId,
  databaseTitle,
  openRun,
  onClose,
}: {
  workspaceId: string;
  databaseId: string;
  databaseTitle: string;
  openRun: { automationId: string; runId: string } | null;
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
  const [mode, setMode] = useState<Mode>(openRun ? { kind: "runs", id: openRun.automationId, focus: openRun.runId } : { kind: "list" });
  const properties = useSchema();

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
  // A menu open over the dialog (a variable picker, a filter's values) closes first, on its own.
  const close = useCallback(() => {
    if (!document.querySelector("[data-floating]")) onClose();
  }, [onClose]);

  return (
    <Dialog open onClose={close} className="max-w-2xl">
      <DatabasesProvider workspaceId={workspaceId}>
      <SequenceChoicesProvider databaseId={databaseId}>
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {mode.kind !== "list" && (
          <IconButton label={t("back")} onClick={() => setMode({ kind: "list" })} className="mt-1">
            <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
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
          start={mode.kind === "edit" && !mode.id ? (mode.start ?? null) : null}
          people={people}
          agents={agents}
          isOwner={isOwner}
          onCancel={() => setMode({ kind: "list" })}
          onUpdated={replace}
          onSaved={(saved, created, stay) => {
            setAutomations((list) => (created ? [...(list ?? []), saved] : (list ?? []).map((a) => (a.id === saved.id ? saved : a))));
            setMode(stay ? { kind: "edit", id: saved.id } : { kind: "list" });
          }}
          onTestDone={(id, runId) => setMode({ kind: "runs", id, focus: runId })}
        />
      ) : mode.kind === "runs" && current ? (
        <RunList workspaceId={workspaceId} automation={current} isOwner={isOwner} focus={mode.focus} />
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
                    onRuns={() => setMode({ kind: "runs", id: automation.id, focus: null })}
                    onDelete={() => void remove(automation)}
                  />
                ))}
              </ul>
            )}
            {!full && <Gallery onUse={(start) => setMode({ kind: "edit", id: null, start })} properties={properties} />}
          </div>
          <Footer error={error}>
            {!full && <FollowUpExampleButton onPick={(start) => setMode({ kind: "edit", id: null, start })} />}
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
      </SequenceChoicesProvider>
      </DatabasesProvider>
    </Dialog>
  );
}

/** Ready-made automations (lib/automation-gallery) fit to this database, to start a new one from. */
function Gallery({ properties, onUse }: { properties: ReturnType<typeof useSchema>; onUse: (draft: Draft) => void }) {
  const t = useTranslations("database.automations.gallery");
  const items = useMemo(() => galleryAutomations(properties), [properties]);
  const use = (item: GalleryAutomation) => {
    const name = t(`${item.key}.name`);
    const message = t(`${item.key}.message`, item.messageValues);
    // Written like a saved automation, so the editor reads it as it reads one.
    const actions = item.actions.map((a) => (a.type === "approval" || a.type === "notify" ? { ...a, message } : a));
    const draft = toDraft({ name, enabled: true, trigger: item.trigger, actions, draft: null } as unknown as Automation, properties);
    onUse(draft);
  };
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1 text-xs font-medium text-fg-muted">{t("title")}</p>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{t(`${item.key}.name`)}</p>
              <p className="text-xs text-fg-muted">{t(`${item.key}.description`)}</p>
            </div>
            <Button size="sm" onClick={() => use(item)}>
              {t("use")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
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
  const neverPublished = automation.version < 1;
  return (
    <li className="flex items-center gap-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm font-medium", (!automation.enabled || neverPublished) && "text-fg-muted")}>{automation.name}</span>
          {neverPublished && (
            <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-4 text-fg-muted">{t("lifecycle.draftBadge")}</span>
          )}
        </div>
        <div className="truncate text-xs text-fg-muted" title={summary}>
          {summary}
        </div>
        <div className={cn("text-xs", last?.status === "failed" ? "text-danger" : "text-fg-faint")}>
          {last
            ? t("lastRun", {
                status: t(`runs.status.${last.status}`),
                time: format.dateTime(new Date(last.at), { dateStyle: "medium", timeStyle: "short" }),
              })
            : neverPublished
              ? t("lifecycle.notRunning")
              : t("neverRun")}
          {automation.nextRunAt && (
            <span className="text-fg-faint">
              {" · "}
              {t("nextRun", { time: format.dateTime(new Date(automation.nextRunAt), { dateStyle: "medium", timeStyle: "short" }) })}
            </span>
          )}
        </div>
        {automation.draft && !neverPublished && <div className="text-xs text-accent">{t("lifecycle.unpublishedHint")}</div>}
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
        <span className="ms-1.5">
          <Switch checked={automation.enabled} label={t("toggle", { name: automation.name })} onChange={onToggle} />
        </span>
      </div>
    </li>
  );
}

/** "When Status becomes Done → Set Date, Notify, Webhook, Run Ticket router": the published steps, or a never published draft's. */
function useSummary(automation: Automation, people: Person[], agents: AgentChoice[]) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const nameOf = (id: string) => properties.find((p) => p.id === id)?.name ?? t("deletedProperty");
  const tGroup = useTranslations("database.statusGroups");
  const format = useFormatter();
  const { trigger, actions } = automation.version < 1 && automation.draft ? automation.draft : automation;
  let when: string;
  if (trigger.type === "row_created") when = t("summaryTrigger.rowCreated");
  else if (trigger.type === "schedule") {
    const s = trigger.schedule;
    // January 4, 2026 is a Sunday: day n of that week names weekday n.
    const weekday = (n: number) => format.dateTime(new Date(Date.UTC(2026, 0, 4 + n, 12)), { weekday: "short", timeZone: "UTC" });
    when =
      s.frequency === "cron"
        ? t("summaryTrigger.cron", { cron: s.cron })
        : s.frequency === "daily"
          ? t("summaryTrigger.daily", { time: s.time })
          : s.frequency === "weekly"
            ? t("summaryTrigger.weekly", { days: s.weekdays.map(weekday).join(", "), time: s.time })
            : t("summaryTrigger.monthly", { days: s.days.map((d) => format.number(d)).join(", "), time: s.time });
    if (automation.timeZone !== browserTimeZone()) when = t("summaryTrigger.inZone", { trigger: when, zone: timeZoneLabel(automation.timeZone) });
  } else if (trigger.type === "incoming_webhook") when = t("summaryTrigger.incoming");
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
  } else {
    const watched = watchedProperties(trigger);
    if (!watched.length) when = t("summaryTrigger.anyChange");
    else if (watched.length > 1) when = t("summaryTrigger.changes", { property: watched.map(nameOf).join(", ") });
    else {
      const prop = properties.find((p) => p.id === watched[0]);
      const value = triggerValueName(trigger.to, prop, people, { checked: t("checked"), unchecked: t("unchecked") });
      when =
        value === null
          ? t("summaryTrigger.changes", { property: nameOf(watched[0]) })
          : t("summaryTrigger.becomes", { property: nameOf(watched[0]), value });
    }
  }
  const steps = actions
    .map((action) => {
      switch (action.type) {
        case "set_properties":
          // Found rows may be another database's, whose properties aren't known here.
          return action.forEach ? t("summaryAction.setEach") : t("summaryAction.set", { properties: Object.keys(action.values).map(nameOf).join(", ") });
        case "notify":
          return t("summaryAction.notify");
        case "run_agent":
          return t("summaryAction.runAgent", { agent: agents.find((a) => a.id === action.agentId)?.name ?? t("summaryAction.archivedAgent") });
        case "move_to_trash":
          return t("summaryAction.trash");
        case "webhook":
          return t("summaryAction.webhook");
        case "approval":
          return t("summaryAction.approval", { people: [...action.userIds.map((id) => people.find((p) => p.id === id)?.name ?? "?"), ...action.propertyIds.map(nameOf)].join(", ") });
        default:
          return t(`form.actionType.${action.type}`);
      }
    })
    .join(", ");
  return t("summary", { trigger: when, actions: steps });
}

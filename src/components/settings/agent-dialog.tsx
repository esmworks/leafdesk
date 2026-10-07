"use client";

import { Bot, ChevronRight, MessageSquare, MessageSquareOff, Plug, RefreshCw, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import {
  createAgentAction,
  listAgentAccessAction,
  listAgentRunsAction,
  removeAgentAccessAction,
  setAgentAccessAction,
  updateAgentAction,
  type AgentRunDetails,
  type AgentStepView,
} from "@/app/actions/agents";
import { StepLine } from "@/components/ai-chat/step-line";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { IconPicker } from "@/components/page/icon-picker";
import { TabButton } from "@/components/settings/members-panel";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, Input, PageIcon, pageLabel, Switch } from "@/components/ui";
import {
  AGENT_ACCESS_LEVELS,
  AGENT_RUN_HISTORY_DAYS,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  type AgentAccessLevel,
  type AgentAccessView,
  type AgentToolRecord,
  type AgentView,
} from "@/lib/agents";
import { AgentConnectionsTab } from "./agent-connections-tab";
import { PagePicker, useShareablePages } from "./agent-page-picker";

export type AgentTab = "settings" | "access" | "connections" | "runs";

export const textareaClass =
  "w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent";

const selectClass = "h-8 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";

/** An agent's emoji, or a robot when it has none. */
export function AgentIcon({ icon, className }: { icon: string | null; className?: string }) {
  if (icon) return <span className={cn("leading-none", className)}>{icon}</span>;
  return <Bot className={cn("h-4 w-4 text-fg-muted", className)} aria-hidden />;
}

/** One agent: its settings, the pages shared with it, the connections' tools it may use and its latest runs, in tabs. */
export function AgentDialog({
  workspaceId,
  agent,
  tab,
  runId,
  onTab,
  onClose,
}: {
  workspaceId: string;
  agent: AgentView;
  tab: AgentTab;
  /** A run to show opened (a link from an automation's history). */
  runId?: string;
  onTab: (tab: AgentTab) => void;
  onClose: () => void;
}) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-lg">
          <AgentIcon icon={agent.icon} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{agent.name}</h2>
          <p className="truncate text-sm text-fg-muted">
            {t(`status.${agent.archived ? "archived" : agent.enabled ? "active" : "paused"}`)}
            {agent.description && ` · ${agent.description}`}
          </p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="border-b border-border px-5 py-2">
        <div role="tablist" aria-label={agent.name} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          {(["settings", "access", "connections", "runs"] as const).map((name) => (
            <TabButton key={name} active={tab === name} onClick={() => onTab(name)}>
              {t(`tabs.${name}`)}
            </TabButton>
          ))}
        </div>
      </div>
      {tab === "settings" ? (
        <AgentForm workspaceId={workspaceId} agent={agent} onDone={onClose} />
      ) : tab === "access" ? (
        <AccessTab workspaceId={workspaceId} agent={agent} />
      ) : tab === "connections" ? (
        <AgentConnectionsTab workspaceId={workspaceId} agent={agent} />
      ) : (
        <RunsTab workspaceId={workspaceId} agent={agent} runId={runId} />
      )}
    </Dialog>
  );
}

/** A new agent (no `agent`) or an agent's settings. */
export function AgentForm({
  workspaceId,
  agent,
  onDone,
  onCreated,
}: {
  workspaceId: string;
  agent?: AgentView;
  onDone: () => void;
  onCreated?: (agent: AgentView) => void;
}) {
  const t = useTranslations("settings.agents.form");
  const tc = useTranslations("common");
  const [icon, setIcon] = useState<string | null>(agent?.icon ?? null);
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const { pending, error, run } = useAction();
  const locked = Boolean(agent?.archived);
  const clean = name.trim();

  const submit = () => {
    if (!clean || locked) return;
    const value = { name: clean, icon, description, instructions, enabled };
    if (agent) run(() => updateAgentAction(workspaceId, agent.id, value), onDone);
    else run(() => createAgentAction(workspaceId, value), (created) => onCreated?.(created));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={locked || pending} className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
        {locked && <p className="text-sm text-fg-muted">{t("archivedNote")}</p>}
        <div className="flex items-end gap-2">
          <IconPicker icon={icon} onChange={setIcon} disabled={locked}>
            {(toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-label={t("chooseIcon")}
                title={t("chooseIcon")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-lg hover:bg-bg-hover"
              >
                <AgentIcon icon={icon} />
              </button>
            )}
          </IconPicker>
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-xs font-medium text-fg-muted">{t("name")}</span>
            <Input autoFocus={!agent} value={name} maxLength={MAX_AGENT_NAME} placeholder={t("namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-fg-muted">{t("description")}</span>
          <Input
            value={description}
            maxLength={MAX_AGENT_DESCRIPTION}
            placeholder={t("descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium text-fg-muted">
            {t("instructions")}
            <span className="font-normal tabular-nums text-fg-faint">
              {t("count", { count: instructions.length, max: MAX_AGENT_INSTRUCTIONS })}
            </span>
          </span>
          <textarea
            rows={9}
            value={instructions}
            maxLength={MAX_AGENT_INSTRUCTIONS}
            placeholder={t("instructionsPlaceholder")}
            onChange={(e) => setInstructions(e.target.value)}
            className={textareaClass}
          />
          <span className="mt-1 block text-xs text-fg-muted">{t("instructionsHelp")}</span>
        </label>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <div>
            <div>{t("active")}</div>
            <div className="text-xs text-fg-muted">{t("activeHelp")}</div>
          </div>
          <Switch checked={enabled} label={t("active")} disabled={locked} onChange={setEnabled} />
        </div>
      </fieldset>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {error && (
          <p role="alert" className="mr-auto text-xs text-danger">
            {error}
          </p>
        )}
        <Button variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={locked || pending || !clean}>
          {agent ? (pending ? tc("saving") : tc("save")) : pending ? t("creating") : t("create")}
        </Button>
      </div>
    </form>
  );
}

/** The pages shared with the agent, their levels, and adding one. */
function AccessTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.access");
  const tc = useTranslations("common");
  const [access, setAccess] = useState<{ pages: AgentAccessView[]; hidden: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [level, setLevel] = useState<AgentAccessLevel>("view");
  const shareable = useShareablePages(workspaceId);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    listAgentAccessAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setAccess(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  const shared = new Set(access?.pages.map((p) => p.pageId));
  const candidates = shareable && shareable.filter((p) => !shared.has(p.id));

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <p className="flex gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span>{t("warning")}</span>
      </p>
      {agent.archived && <p className="text-sm text-fg-muted">{t("archived")}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!access ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          {access.pages.length ? (
            <ul aria-label={t("list")} className="divide-y divide-border rounded-md border border-border">
              {access.pages.map((p) => {
                const title = pageLabel(p.title, tc("untitled"));
                return (
                  <li key={p.pageId} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
                    <Link href={`/w/${workspaceId}/p/${p.pageId}`} className="min-w-0 flex-1 truncate hover:underline">
                      {title}
                    </Link>
                    <select
                      value={p.level}
                      aria-label={t("levelFor", { title })}
                      disabled={pending || agent.archived}
                      onChange={(e) =>
                        run(() => setAgentAccessAction(workspaceId, agent.id, p.pageId, e.target.value as AgentAccessLevel), setAccess)
                      }
                      className={selectClass}
                    >
                      {AGENT_ACCESS_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {t(`level.${l}`)}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      label={t("remove", { title })}
                      disabled={pending}
                      onClick={() => run(() => removeAgentAccessAction(workspaceId, agent.id, p.pageId), setAccess)}
                      className="hover:text-danger"
                    >
                      <X className="h-4 w-4" />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{t("empty")}</p>
          )}
          {access.hidden > 0 && <p className="text-xs text-fg-muted">{t("hidden", { count: access.hidden })}</p>}
          <p className="text-xs text-fg-muted">{t("automationNote")}</p>
          {!agent.archived &&
            (adding ? (
              <section className="space-y-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{t("add")}</h3>
                  <label className="flex items-center gap-2 text-sm text-fg-muted">
                    {t("addAs")}
                    <select value={level} onChange={(e) => setLevel(e.target.value as AgentAccessLevel)} className={selectClass}>
                      {AGENT_ACCESS_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {t(`level.${l}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <PagePicker
                  autoFocus
                  pages={candidates}
                  label={t("search")}
                  empty={t("noPages")}
                  onPick={(page) =>
                    run(() => setAgentAccessAction(workspaceId, agent.id, page.id, level), (next) => {
                      setAccess(next);
                      setAdding(false);
                    })
                  }
                />
                <p className="text-xs text-fg-faint">{t("fullOnly")}</p>
              </section>
            ) : (
              <Button onClick={() => setAdding(true)}>{t("add")}</Button>
            ))}
        </>
      )}
    </div>
  );
}

/** How long a run took ("12s", "1m 5s"), in the chat's words. */
function useDuration() {
  const t = useTranslations("ai.chat.steps");
  return (from: string, to: string | null) => {
    if (!to) return null;
    const seconds = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
    return seconds < 60 ? t("seconds", { s: seconds }) : t("minutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
  };
}

/** The agent's latest runs; each opens to its steps, what it said, and why it failed. */
function RunsTab({ workspaceId, agent, runId }: { workspaceId: string; agent: AgentView; runId?: string }) {
  const t = useTranslations("settings.agents.runs");
  const tc = useTranslations("common");
  const [runs, setRuns] = useState<AgentRunDetails[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    listAgentRunsAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setRuns(res.data);
          setError(null);
        } else setError(res.error);
      })
      .catch(() => live && setError(tc("genericError")))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, version, tc]);

  return (
    <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
      <div className="flex items-center gap-2 pb-2">
        <p className="min-w-0 flex-1 text-xs text-fg-muted">{t("description", { days: AGENT_RUN_HISTORY_DAYS })}</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setVersion((v) => v + 1);
          }}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
      </div>
      {!runs ? (
        <p className="py-3 text-sm text-fg-muted" role={error ? "alert" : undefined}>
          {error ?? tc("loading")}
        </p>
      ) : runs.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <RunItem key={run.id} workspaceId={workspaceId} run={run} initiallyOpen={run.id === runId} onChanged={() => setVersion((v) => v + 1)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunItem({
  workspaceId,
  run,
  initiallyOpen,
  onChanged,
}: {
  workspaceId: string;
  run: AgentRunDetails;
  initiallyOpen: boolean;
  /** The run changed here (an owner answered its call): load the runs again. */
  onChanged: () => void;
}) {
  const t = useTranslations("settings.agents.runs");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const duration = useDuration();
  const [open, setOpen] = useState(initiallyOpen || run.pending !== null);
  const took = duration(run.createdAt, run.finishedAt);
  const failed = run.status === "failed";

  return (
    <li className="py-2.5" ref={initiallyOpen ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t("hideDetails") : t("showDetails")}
          onClick={() => setOpen(!open)}
          className="mt-0.5 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {run.source.kind === "connection" ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <Plug aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className="truncate">
                  {t("fromConnection", { connection: run.connections[run.source.connectionId] ?? t("removedConnection"), event: run.eventType ?? "" })}
                </span>
              </span>
            ) : run.rowTitle !== null ? (
              <Link href={`/w/${workspaceId}/p/${run.source.rowId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                {pageLabel(run.rowTitle, tc("untitled"))}
              </Link>
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{t("rowHidden")}</span>
            )}
            <span className={cn("shrink-0 text-xs", failed ? "text-danger" : run.status === "awaiting_approval" ? "font-medium text-fg" : "text-fg-muted")}>
              {t(`status.${run.status}`)}
            </span>
          </div>
          <div className="text-xs text-fg-faint">
            {format.dateTime(new Date(run.createdAt), { dateStyle: "medium", timeStyle: "short" })}
            {took && ` · ${t("took", { time: took })}`}
          </div>
          {failed && run.code && <p className="mt-0.5 text-xs text-danger">{t(`reason.${run.code}`)}</p>}
        </div>
      </div>
      {open && (
        <div className="mt-2 ml-6 space-y-2 text-sm">
          {run.steps.length > 0 ? (
            <ol className="ml-1.5 space-y-1 border-l border-border pl-3 text-fg-muted">
              {run.steps.map((step, i) => (
                <li key={i} className="flex min-w-0 items-start gap-1.5">
                  <AgentStepLine step={step} connections={run.connections} onOpen={(pageId) => router.push(`/w/${workspaceId}/p/${pageId}`)} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-fg-muted">{t("noSteps")}</p>
          )}
          {run.pending && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-1.5 text-sm font-medium">{t("waiting")}</p>
              <ApprovalActions
                workspaceId={workspaceId}
                approval={{ runId: run.id, callId: run.pending.callId, tool: run.pending.tool, connectionName: run.pending.connectionName, input: JSON.stringify(run.pending.arguments, null, 2) }}
                onAnswered={onChanged}
              />
            </div>
          )}
          {run.answer && (
            <div>
              <p className="mb-0.5 text-xs font-medium text-fg-muted">{t("answer")}</p>
              <p className="text-sm break-words whitespace-pre-wrap">{run.answer}</p>
            </div>
          )}
          {run.error && failed && <p className="text-xs break-words text-fg-faint">{run.error}</p>}
        </div>
      )}
    </li>
  );
}

/** A step of a run: the chat's steps, the comments the agent wrote, and its calls to connections. */
function AgentStepLine({ step, connections, onOpen }: { step: AgentStepView; connections: Record<string, string>; onOpen: (pageId: string) => void }) {
  const t = useTranslations("settings.agents.runs");
  if (step.kind === "tool") return <ToolStepLine step={step} connection={connections[step.connectionId] ?? t("removedConnection")} />;
  if (step.kind !== "comment") return <StepLine step={step} onSource={(source) => source.pageId && onOpen(source.pageId)} />;
  const failed = step.outcome === "failed";
  const Icon = failed ? MessageSquareOff : MessageSquare;
  return (
    <>
      <Icon className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", failed && "text-danger")} />
      <span className="min-w-0 break-words">
        {step.text === null ? (
          t("commentHidden")
        ) : (
          <>
            {t(failed ? "commentFailed" : "comment")} <span className="text-fg">“{step.text}”</span>
          </>
        )}
      </span>
    </>
  );
}

/** A call to a connection's tool: which, with what, and how it went (and who answered, when someone did). */
function ToolStepLine({ step, connection }: { step: AgentToolRecord; connection: string }) {
  const t = useTranslations("settings.agents.runs.tool");
  const bad = step.outcome === "failed" || step.outcome === "expired";
  return (
    <>
      <Plug className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", bad && "text-danger")} />
      <span className="min-w-0 break-words">
        {t(step.outcome, { tool: step.tool, connection })}
        {step.decidedBy && step.outcome !== "expired" && <span className="text-fg-faint"> · {t(step.outcome === "done" ? "approved" : "answered")}</span>}
        {step.note && <span className="block text-xs text-fg-faint">{t("note", { note: step.note })}</span>}
        <code className="mt-0.5 block truncate text-xs text-fg-faint" title={step.input}>
          {step.input}
        </code>
      </span>
    </>
  );
}

/** A labelled field of the agents' forms. */
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-fg-muted">{help}</span>}
    </div>
  );
}

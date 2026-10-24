"use client";

import { IconGlyph } from "@/components/builtin-icon";
import { BookCheck, BookX, Bot, CalendarClock, ChevronRight, Globe, Mail, MailX, MessageSquare, MessageSquareOff, MessagesSquare, Play, Plug, RefreshCw, TriangleAlert, Users, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  agentUsageAction,
  createAgentAction,
  listAgentAccessAction,
  listAgentRunsAction,
  removeAgentAccessAction,
  setAgentAccessAction,
  updateAgentAction,
  type AgentEmailView,
  type AgentRunDetails,
  type AgentStepView,
} from "@/app/actions/agents";
import type { ActionResult } from "@/app/actions/workspaces";
import { StepLine } from "@/components/ai-chat/step-line";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { IconPicker } from "@/components/page/icon-picker";
import { TabButton } from "@/components/settings/members-panel";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, Input, PageIcon, pageLabel, selectClass, Switch, textareaClass } from "@/components/ui";
import type { AgentInput } from "@/server/agents/manage";
import {
  AGENT_ACCESS_LEVELS,
  AGENT_RUN_HISTORY_DAYS,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  MAX_AGENT_TOKEN_LIMIT,
  OWN_TOOLS_NAME,
  WEB_TOOL_NAMES,
  type AgentAccessLevel,
  type AgentAccessView,
  type AgentModel,
  type AgentRowChanges,
  type AgentSkillRecord,
  type AgentToolRecord,
  type AgentUsageMonth,
  type AgentView,
  editsAgent,
} from "@/lib/agents";
import { commentHash } from "@/lib/comments";
import { AgentChatTab } from "./agent-chat-tab";
import { AgentConnectionsTab } from "./agent-connections-tab";
import { AgentHistoryTab } from "./agent-history-tab";
import { AskedByLine, HandoffStepLine, type OpenAgentRun } from "./agent-handoff-step";
import { AgentHelpersField } from "./agent-helpers-field";
import { AgentMemoryTab } from "./agent-memory-tab";
import { AgentSchedulesTab } from "./agent-schedules-tab";
import { AgentSkillsTab } from "./agent-skills-tab";
import { PagePicker, useShareablePages } from "./agent-page-picker";

/** The dialog's tabs; `share`, who the agent is shared with, opens from its header rather than the tab bar. */
export type AgentTab = "settings" | "access" | "skills" | "memory" | "connections" | "schedules" | "runs" | "chat" | "history" | "share";
/** The server's main and fast models' names, shown with the agent's choice between them. */
export type AgentModelNames = { main: string; fast: string };
export const AGENT_TABS: readonly Exclude<AgentTab, "share">[] = ["settings", "access", "skills", "memory", "connections", "schedules", "runs", "chat", "history"];

// Sharing comes with its section, not with the dialog.
const AgentShareTab = dynamic(() => import("./agent-share-tab").then((m) => m.AgentShareTab), {
  ssr: false,
  loading: () => <div aria-busy="true" className="m-5 h-24 animate-pulse rounded-md bg-bg-subtle" />,
});

/** An agent's emoji, or a robot when it has none. */
export function AgentIcon({ icon, className }: { icon: string | null; className?: string }) {
  if (icon) return <IconGlyph icon={icon} className={className} />;
  return <Bot className={cn("h-4 w-4 text-fg-muted", className)} aria-hidden />;
}

/**
 * One agent: its settings, the pages shared with it, its skills, its memory, the connections' tools
 * it may use, its schedules, its latest runs, a chat with it and its versions, in tabs, and who it
 * is shared with. What the viewer may change follows their level on it (`agent.access`): those who
 * can view and interact see every tab read-only, their own runs alone, and chat with it.
 */
export function AgentDialog({
  workspaceId,
  isOwner,
  agent,
  tab,
  runId,
  proposals = 0,
  memoryOff = false,
  models = null,
  webSearch = false,
  onTab,
  onOpenRun,
  onClose,
}: {
  workspaceId: string;
  /** The viewer owns the workspace: they choose the connections' tools and the token limit, and answer calls. */
  isOwner: boolean;
  agent: AgentView;
  tab: AgentTab;
  /** The models an agent may choose between; null hides the choice (see AgentForm). */
  models?: AgentModelNames | null;
  /** Notes its runs proposed that wait for an owner, counted on the Memory tab. */
  proposals?: number;
  memoryOff?: boolean;
  /** The server has a search service (see AgentForm). */
  webSearch?: boolean;
  /** A run to show opened (a link from an automation's history). */
  runId?: string;
  onTab: (tab: AgentTab) => void;
  /** Opens a run of another agent (one this agent asked, or that asked it). */
  onOpenRun?: OpenAgentRun;
  onClose: () => void;
}) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  const tabs = useRef<HTMLDivElement>(null);
  // A tab a link opens may be past the edge of a narrow window.
  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  return (
    <Dialog open onClose={onClose} className="max-w-3xl">
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
        <Button size="sm" variant={tab === "share" ? "primary" : "ghost"} aria-pressed={tab === "share"} onClick={() => onTab("share")}>
          <Users className="h-3.5 w-3.5" />
          {t("share.button")}
        </Button>
        <IconButton label={tc("close")} onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {/* Nine tabs don't fit a phone: they scroll on their own, without a bar, rather than widening the dialog. */}
      <div ref={tabs} className="overflow-x-auto border-b border-border px-5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label={agent.name} className="inline-flex w-max gap-0.5 rounded-lg bg-bg-hover p-0.5">
          {AGENT_TABS.map((name) => (
            <TabButton key={name} active={tab === name} onClick={() => onTab(name)}>
              {t(`tabs.${name}`)}
              {name === "memory" && proposals > 0 && (
                <span className="rounded bg-accent px-1 text-xs font-medium text-accent-fg tabular-nums" aria-label={t("memory.waiting", { count: proposals })}>
                  {proposals}
                </span>
              )}
            </TabButton>
          ))}
        </div>
      </div>
      {!editsAgent(agent) && tab !== "share" && tab !== "chat" && <p className="border-b border-border bg-bg-subtle px-5 py-2 text-xs text-fg-muted">{t("viewOnly")}</p>}
      {tab === "share" ? (
        <AgentShareTab workspaceId={workspaceId} agent={agent} />
      ) : tab === "settings" ? (
        <AgentForm workspaceId={workspaceId} agent={agent} isOwner={isOwner} models={models} webSearch={webSearch} onDone={onClose} />
      ) : tab === "access" ? (
        <AccessTab workspaceId={workspaceId} agent={agent} />
      ) : tab === "skills" ? (
        <AgentSkillsTab workspaceId={workspaceId} agent={agent} />
      ) : tab === "memory" ? (
        <AgentMemoryTab workspaceId={workspaceId} agent={agent} memoryOff={memoryOff} />
      ) : tab === "connections" ? (
        <AgentConnectionsTab workspaceId={workspaceId} agent={agent} isOwner={isOwner} />
      ) : tab === "schedules" ? (
        <AgentSchedulesTab workspaceId={workspaceId} agent={agent} onRuns={() => onTab("runs")} />
      ) : tab === "history" ? (
        <AgentHistoryTab workspaceId={workspaceId} agent={agent} />
      ) : tab === "chat" ? (
        <AgentChatTab workspaceId={workspaceId} agent={agent} />
      ) : (
        <RunsTab workspaceId={workspaceId} agent={agent} isOwner={isOwner} runId={runId} onOpenRun={onOpenRun} />
      )}
    </Dialog>
  );
}

/** What a new agent's form starts with, and how it is created: a drafted agent (see agent-describe-dialog). */
export type AgentFormDraft = {
  initial: Pick<AgentView, "name" | "icon" | "description" | "instructions">;
  /** Shown under the instructions: what creating it sets up besides. */
  extra?: ReactNode;
  create: (value: AgentInput) => Promise<ActionResult<AgentView>>;
};

/** A new agent (no `agent`, prefilled from `draft` when given) or an agent's settings. */
export function AgentForm({
  workspaceId,
  isOwner,
  agent,
  models = null,
  webSearch = false,
  draft,
  onDone,
  onCreated,
}: {
  workspaceId: string;
  /** Only owners set the monthly token limit (it is what the agent costs); anyone else sees it. */
  isOwner: boolean;
  agent?: AgentView;
  /**
   * The server's main and fast models, when the agent may choose between them. Null (no fast
   * model, or an own AI account) hides the choice and leaves the stored one as it is: a "fast"
   * agent then runs on the main model.
   */
  models?: AgentModelNames | null;
  /** The server has a search service: the web access switch says the agent can search too. */
  webSearch?: boolean;
  draft?: AgentFormDraft;
  onDone: () => void;
  onCreated?: (agent: AgentView) => void;
}) {
  const t = useTranslations("settings.agents.form");
  const tc = useTranslations("common");
  const start = agent ?? draft?.initial;
  const [icon, setIcon] = useState<string | null>(start?.icon ?? null);
  const [name, setName] = useState(start?.name ?? "");
  const [description, setDescription] = useState(start?.description ?? "");
  const [instructions, setInstructions] = useState(start?.instructions ?? "");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [webAccess, setWebAccess] = useState(agent?.webAccess ?? false);
  const [limit, setLimit] = useState(agent?.monthlyTokenLimit ? String(agent.monthlyTokenLimit) : "");
  const [model, setModel] = useState<AgentModel>(agent?.model ?? "main");
  const [rowChanges, setRowChanges] = useState<AgentRowChanges>(agent?.rowChanges ?? "direct");
  // Null until loaded: saving then leaves them as they are.
  const [helpers, setHelpers] = useState<string[] | null>(null);
  const { pending, error, run } = useAction();
  // Archived, or shared with the viewer to view and interact only.
  const locked = Boolean(agent?.archived) || (agent ? !editsAgent(agent) : false);
  const clean = name.trim();
  // Empty: no limit. The server checks the number again.
  const monthlyTokenLimit = limit.trim() ? Number(limit.trim()) : null;
  const limitValid = monthlyTokenLimit === null || (Number.isInteger(monthlyTokenLimit) && monthlyTokenLimit >= 1 && monthlyTokenLimit <= MAX_AGENT_TOKEN_LIMIT);

  const submit = () => {
    if (!clean || locked || !limitValid) return;
    const value = {
      name: clean,
      icon,
      description,
      instructions,
      enabled,
      webAccess,
      rowChanges,
      // Left as it is by anyone but an owner.
      ...(isOwner ? { monthlyTokenLimit } : {}),
      ...(models ? { model } : {}),
      helperAgentIds: helpers ?? undefined,
    };
    if (agent) run(() => updateAgentAction(workspaceId, agent.id, value), onDone);
    else run(() => (draft ? draft.create(value) : createAgentAction(workspaceId, value)), (created) => onCreated?.(created));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={locked || pending} className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
        {agent?.archived && <p className="text-sm text-fg-muted">{t("archivedNote")}</p>}
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
        {draft?.extra}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <div>
            <div>{t("active")}</div>
            <div className="text-xs text-fg-muted">{t("activeHelp")}</div>
          </div>
          <Switch checked={enabled} label={t("active")} disabled={locked} onChange={setEnabled} />
        </div>
        {models && (
          <label className="block border-t border-border pt-3">
            <span className="mb-1 block text-sm">{t("model")}</span>
            <select value={model} onChange={(e) => setModel(e.target.value as AgentModel)} className={cn(selectClass, "w-full sm:w-auto")}>
              <option value="main">{t("modelMain", { name: models.main })}</option>
              <option value="fast">{t("modelFast", { name: models.fast })}</option>
            </select>
            <span className="mt-1 block text-xs text-fg-muted">{t("modelHelp")}</span>
          </label>
        )}
        <label className="block border-t border-border pt-3">
          <span className="mb-1 block text-sm">{t("rowChanges")}</span>
          <select
            value={rowChanges}
            disabled={locked}
            onChange={(e) => setRowChanges(e.target.value as AgentRowChanges)}
            className={cn(selectClass, "w-full sm:w-auto")}
          >
            <option value="direct">{t("rowChangesDirect")}</option>
            <option value="review">{t("rowChangesReview")}</option>
          </select>
          <span className="mt-1 block text-xs text-fg-muted">{t(rowChanges === "review" ? "rowChangesReviewHelp" : "rowChangesDirectHelp")}</span>
        </label>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <div>
            <div>{t("webAccess")}</div>
            <div className="text-xs text-fg-muted">{t(webSearch ? "webAccessHelpSearch" : "webAccessHelp")}</div>
          </div>
          <Switch checked={webAccess} label={t("webAccess")} disabled={locked} onChange={setWebAccess} />
        </div>
        <label className="block border-t border-border pt-3">
          <span className="mb-1 block text-sm">{t("limit")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_AGENT_TOKEN_LIMIT}
            step={1}
            value={limit}
            placeholder={t("limitPlaceholder")}
            aria-invalid={!limitValid}
            disabled={!isOwner}
            onChange={(e) => setLimit(e.target.value)}
            className="w-48"
          />
          <span className={cn("mt-1 block text-xs", limitValid ? "text-fg-muted" : "text-danger")}>
            {!limitValid ? t("limitInvalid") : isOwner ? t("limitHelp") : t("limitOwnersOnly")}
          </span>
        </label>
        <AgentHelpersField workspaceId={workspaceId} agentId={agent?.id ?? null} value={helpers} disabled={locked} onChange={setHelpers} />
      </fieldset>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {error && (
          <p role="alert" className="me-auto text-xs text-danger">
            {error}
          </p>
        )}
        <Button variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={locked || pending || !clean || !limitValid}>
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
  const editable = editsAgent(agent);

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
                    {editable ? (
                      <>
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
                      </>
                    ) : (
                      <span className="shrink-0 text-sm text-fg-muted">{t(`level.${p.level}`)}</span>
                    )}
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
            editable &&
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
/** Those who can view and interact see the runs they started alone (the server leaves the others out). */
function RunsTab({
  workspaceId,
  agent,
  isOwner,
  runId,
  onOpenRun,
}: {
  workspaceId: string;
  agent: AgentView;
  isOwner: boolean;
  runId?: string;
  onOpenRun?: OpenAgentRun;
}) {
  const t = useTranslations("settings.agents.runs");
  const tc = useTranslations("common");
  const [runs, setRuns] = useState<AgentRunDetails[] | null>(null);
  const [usage, setUsage] = useState<AgentUsageMonth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    agentUsageAction(workspaceId, agent.id)
      .then((res) => live && res.ok && setUsage(res.data))
      .catch(() => undefined);
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
        <p className="min-w-0 flex-1 text-xs text-fg-muted">
          {t("description", { days: AGENT_RUN_HISTORY_DAYS })}
          {!editsAgent(agent) && ` ${t("yoursOnly")}`}
        </p>
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
      {usage && <UsageSummary usage={usage} limit={agent.monthlyTokenLimit} />}
      {!runs ? (
        <p className="py-3 text-sm text-fg-muted" role={error ? "alert" : undefined}>
          {error ?? tc("loading")}
        </p>
      ) : runs.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <RunItem
              key={run.id}
              workspaceId={workspaceId}
              run={run}
              answers={isOwner}
              initiallyOpen={run.id === runId}
              onChanged={() => setVersion((v) => v + 1)}
              onOpenRun={onOpenRun}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the agent's runs used this month (against its limit), and in the months before. */
function UsageSummary({ usage, limit }: { usage: AgentUsageMonth[]; limit: number | null }) {
  const t = useTranslations("settings.agents.usage");
  const format = useFormatter();
  const [current, ...earlier] = usage;
  const tokens = (m: AgentUsageMonth) => m.inputTokens + m.outputTokens;
  const used = tokens(current);
  const share = limit ? Math.min(1, used / limit) : 0;
  const month = (m: AgentUsageMonth) => format.dateTime(new Date(`${m.month}-01T00:00:00Z`), { year: "numeric", month: "long", timeZone: "UTC" });
  const line = (m: AgentUsageMonth) =>
    [
      t("tokens", { count: tokens(m) }),
      ...(m.costUsd > 0 ? [format.number(m.costUsd, { style: "currency", currency: "USD", maximumFractionDigits: m.costUsd < 1 ? 4 : 2 })] : []),
      t("runs", { count: m.runs }),
    ].join(" · ");

  return (
    <div className="mb-2 rounded-md border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span>{t("thisMonth", { usage: line(current) })}</span>
        {limit !== null && (
          <span className={cn("text-xs", used >= limit ? "text-danger" : "text-fg-muted")}>
            {used >= limit ? t("limitReached", { limit: format.number(limit) }) : t("ofLimit", { limit: format.number(limit) })}
          </span>
        )}
      </div>
      {limit !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-hover" aria-hidden>
          <div className={cn("h-full", used >= limit ? "bg-danger" : "bg-fg-muted")} style={{ width: `${share * 100}%` }} />
        </div>
      )}
      {earlier.length > 0 && (
        <details className="mt-1.5 text-xs text-fg-muted">
          <summary className="cursor-pointer select-none">{t("earlier")}</summary>
          <ul className="mt-1 space-y-0.5">
            {earlier.map((m) => (
              <li key={m.month} className="flex justify-between gap-3">
                <span>{month(m)}</span>
                <span className="tabular-nums">{line(m)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RunItem({
  workspaceId,
  run,
  answers,
  initiallyOpen,
  onChanged,
  onOpenRun,
}: {
  workspaceId: string;
  run: AgentRunDetails;
  /** The viewer answers its calls to connections (an owner); anyone else sees that it waits. */
  answers: boolean;
  initiallyOpen: boolean;
  /** The run changed here (an owner answered its call): load the runs again. */
  onChanged: () => void;
  onOpenRun?: OpenAgentRun;
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
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open ? "rotate-90" : "rtl:rotate-180")} />
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
            ) : run.source.kind === "schedule" ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <CalendarClock aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className="truncate">
                  {!run.schedule?.databaseId
                    ? t("fromSchedule")
                    : run.schedule.databaseTitle
                      ? t("fromScheduleOn", { database: pageLabel(run.schedule.databaseTitle, tc("untitled")) })
                      : t("fromScheduleHidden")}
                </span>
              </span>
            ) : run.source.kind === "mention" ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <MessageSquare aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                {run.mention?.pageTitle != null ? (
                  <Link href={`/w/${workspaceId}/p/${run.source.pageId}${commentHash(run.source.threadId)}`} className="truncate hover:underline">
                    {t("fromMention", { name: run.mention.byName, page: pageLabel(run.mention.pageTitle, tc("untitled")) })}
                  </Link>
                ) : (
                  <span className="truncate">{t("fromMentionHidden", { name: run.mention?.byName ?? "" })}</span>
                )}
              </span>
            ) : run.source.kind === "handoff" ? (
              run.handoff && <AskedByLine handoff={run.handoff} onOpenRun={onOpenRun} />
            ) : run.source.kind === "chat" ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <MessagesSquare aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className={cn("truncate", !run.chat?.message && "text-fg-muted")}>{run.chat?.message || t("fromChat", { name: run.chat?.byName ?? "" })}</span>
              </span>
            ) : run.source.kind === "request" && !run.source.rowId ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                <Play aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className="truncate">{run.request?.task}</span>
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
            {run.request && ` · ${t("requestedBy", { name: run.request.byName, via: run.request.via })}`}
            {run.schedule && ` · ${t("scheduledBy", { name: run.schedule.byName })}`}
            {run.usage?.model && ` · ${t("model", { model: run.usage.model })}`}
            {run.chat && ` · ${t("chattedBy", { name: run.chat.byName })}`}
          </div>
          {failed && run.code && <p className="mt-0.5 text-xs text-danger">{t(`reason.${run.code}`)}</p>}
        </div>
      </div>
      {open && (
        <div className="mt-2 ms-6 space-y-2 text-sm">
          {(run.request?.task || run.schedule?.task || run.handoff?.task) && (
            <p className="whitespace-pre-wrap text-fg-muted">
              <span className="text-xs font-medium">{t("task")}</span> {run.request?.task || run.schedule?.task || run.handoff?.task}
            </p>
          )}
          {run.mention?.task && (
            <p className="whitespace-pre-wrap text-fg-muted">
              <span className="text-xs font-medium">{t("mentionComment")}</span> {run.mention.task}
            </p>
          )}
          {run.steps.length > 0 ? (
            <ol className="ms-1.5 space-y-1 border-s border-border ps-3 text-fg-muted">
              {run.steps.map((step, i) => (
                <li key={i} className="flex min-w-0 items-start gap-1.5">
                  <AgentStepLine
                    step={step}
                    connections={run.connections}
                    onOpen={(pageId) => router.push(`/w/${workspaceId}/p/${pageId}`)}
                    onOpenRun={onOpenRun}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-fg-muted">{t("noSteps")}</p>
          )}
          {run.pending && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-1.5 text-sm font-medium">{t("waiting")}</p>
              {answers ? (
                <ApprovalActions
                  workspaceId={workspaceId}
                  approval={{ runId: run.id, callId: run.pending.callId, tool: run.pending.tool, connectionName: run.pending.connectionName, input: JSON.stringify(run.pending.arguments, null, 2) }}
                  onAnswered={onChanged}
                />
              ) : (
                <p className="text-xs text-fg-muted">{t("waitingForOwner")}</p>
              )}
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

/** A step of a run: the chat's steps, the comments the agent wrote, its calls to connections and the agents it asked. */
export function AgentStepLine({
  step,
  connections,
  onOpen,
  onOpenRun,
}: {
  step: AgentStepView;
  connections: Record<string, string>;
  onOpen: (pageId: string) => void;
  onOpenRun?: OpenAgentRun;
}) {
  const t = useTranslations("settings.agents.runs");
  if (step.kind === "tool" && step.connectionId === null && (step.outcome === "done" || step.outcome === "failed") && webTool(step.tool)) {
    return <WebStepLine step={step} />;
  }
  if (step.kind === "handoff") return <HandoffStepLine step={step} onOpenRun={onOpenRun} />;
  if (step.kind === "tool") {
    const connection = step.connectionId === null ? OWN_TOOLS_NAME : (connections[step.connectionId] ?? t("removedConnection"));
    return <ToolStepLine step={step} connection={connection} />;
  }
  if (step.kind === "skill") return <SkillStepLine step={step} onOpen={onOpen} />;
  if (step.kind === "email") return <EmailStepLine step={step} />;
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

/** An email the run drafted for its sender's review, or couldn't; its subject only to those who may open the row. */
function EmailStepLine({ step }: { step: AgentEmailView }) {
  const t = useTranslations("settings.agents.runs");
  const failed = step.outcome === "failed";
  const Icon = failed ? MailX : Mail;
  return (
    <>
      <Icon className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", failed && "text-danger")} />
      <span className="min-w-0 break-words">
        {step.subject === null ? (
          t("emailHidden")
        ) : (
          <>
            {t(failed ? "emailFailed" : "emailDrafted")} {step.subject && <span className="text-fg">“{step.subject}”</span>}
          </>
        )}
      </span>
    </>
  );
}

/** A skill the run followed, or left out and why; named only to those who may open it. */
function SkillStepLine({ step, onOpen }: { step: AgentSkillRecord; onOpen: (pageId: string) => void }) {
  const t = useTranslations("settings.agents.runs.skill");
  const tc = useTranslations("common");
  const skipped = step.outcome === "skipped";
  const Icon = skipped ? BookX : BookCheck;
  const name = step.title ? (
    <button type="button" onClick={() => onOpen(step.pageId)} className="text-fg hover:underline">
      {pageLabel(step.title, tc("untitled"))}
    </button>
  ) : (
    t("hidden")
  );
  return (
    <>
      <Icon className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", skipped && "text-danger")} />
      <span className="min-w-0 break-words">{skipped ? t.rich(`skipped.${step.reason}`, { name: () => name }) : t.rich("used", { name: () => name })}</span>
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

const webTool = (name: string) => name === WEB_TOOL_NAMES.read || name === WEB_TOOL_NAMES.search;

/** A page the run read from the web, or a search it made: the address or the query, and whether it worked. */
function WebStepLine({ step }: { step: AgentToolRecord }) {
  const t = useTranslations("settings.agents.runs.web");
  const failed = step.outcome === "failed";
  const search = step.tool === WEB_TOOL_NAMES.search;
  // The input is the call's arguments as JSON, cut to fit: the address or the query when it parses.
  let target = step.input;
  try {
    const args = JSON.parse(step.input) as Record<string, unknown>;
    const value = search ? args.query : args.url;
    if (typeof value === "string") target = value;
  } catch {}
  return (
    <>
      <Globe className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", failed && "text-danger")} />
      <span className="min-w-0 break-words">
        {t(search ? (failed ? "searchFailed" : "search") : failed ? "readFailed" : "read")}
        {step.decidedBy && <span className="text-fg-faint"> · {t("approved")}</span>}
        <code className="mt-0.5 block truncate text-xs text-fg-faint" title={target}>
          {target}
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

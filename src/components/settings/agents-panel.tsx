"use client";

import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { archiveAgentAction, duplicateAgentAction, restoreAgentAction, updateAgentAction } from "@/app/actions/agents";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Floating, useFloating } from "@/components/database/floating";
import { lazyPart } from "@/components/lazy-part";
import { TabButton } from "@/components/settings/members-panel";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, IconButton, MenuItem, MenuSeparator, selectClass } from "@/components/ui";
import { AGENT_CREATIONS, hasAgentLevel, type AgentCreation } from "@/lib/agent-sharing";
import { settingAnchor } from "@/lib/settings-search";
import { editsAgent, MAX_AGENTS, type AgentView, type CopyLeftOut } from "@/lib/agents";
import type { BuiltinAgentSummary } from "@/lib/builtin-agents";
import { AgentDescribeDialog } from "./agent-describe-dialog";
import { AgentDialog, AgentForm, AgentIcon, type AgentModelNames, type AgentTab } from "./agent-dialog";
import { TemplateWizard } from "./agent-template-wizard";

// Shown only while owners choose who creates agents.
const AgentCreatorsList = lazyPart(() => import("./agent-creators-list").then((m) => m.AgentCreatorsList), <div aria-busy="true" className="h-16 animate-pulse rounded-md bg-bg-subtle" />);

/**
 * Settings > Agents: the workspace's agents shared with the viewer (every one, for owners), active
 * or archived. Owners, and members when the workspace lets them (`creation`), create them (from
 * scratch, from a template, or from a description the AI drafts them from). Opening one shows it;
 * what the viewer may change in it, pause, archive and restore follows their level on it.
 */
export function AgentsPanel({
  workspaceId,
  isOwner,
  creation,
  canCreate,
  agents,
  proposals = {},
  memoryOff = false,
  webSearch = false,
  templates,
  ai,
  models = null,
  initialAgentId,
  initialRunId,
  initialTab,
}: {
  workspaceId: string;
  isOwner: boolean;
  /** Who may create agents in the workspace; owners change it here. */
  creation: AgentCreation;
  /** The viewer may create agents (an owner, or a member when `creation` lets members). */
  canCreate: boolean;
  /** Those shared with the viewer (all of them, for owners), archived ones too. */
  agents: AgentView[];
  /** Per agent the viewer can edit, the notes its runs proposed that wait for review. */
  proposals?: Record<string, number>;
  /** The workspace's AI memory is off: runs carry no notes and keep none. */
  memoryOff?: boolean;
  /** The server has a search service: agents with web access can search the web too. */
  webSearch?: boolean;
  templates: BuiltinAgentSummary[];
  /** Whether agents can run: AI set up on the server and on in the workspace. */
  ai: "on" | "off" | "unavailable";
  /** The server's main and fast models, when an agent may choose between them (see AgentForm). */
  models?: AgentModelNames | null;
  initialAgentId?: string;
  initialRunId?: string;
  /** The tab of `initialAgentId` a link opens (its runs when it names a run, else its settings). */
  initialTab?: AgentTab;
}) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  const [view, setView] = useState<"active" | "archived">(() =>
    agents.find((a) => a.id === initialAgentId)?.archived ? "archived" : "active",
  );
  const [open, setOpen] = useState<{ id: string; tab: AgentTab } | null>(() =>
    initialAgentId && agents.some((a) => a.id === initialAgentId) ? { id: initialAgentId, tab: initialRunId ? "runs" : (initialTab ?? "settings") } : null,
  );
  // An agent just made, until the refreshed list brings it.
  const [made, setMade] = useState<AgentView | null>(null);
  const [creating, setCreating] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  // The copy just made, what it was copied from and what it left out, said in its dialog.
  const [copied, setCopied] = useState<{ id: string; from: string; leftOut: CopyLeftOut } | null>(null);
  const [template, setTemplate] = useState<BuiltinAgentSummary | null>(null);
  // The run a link opened (from an automation's runs), until its agent is closed.
  const [linkedRun, setLinkedRun] = useState(initialRunId);
  const { pending, error, run } = useAction();

  const find = (id: string) => agents.find((a) => a.id === id) ?? (made?.id === id ? made : undefined);
  const opened = open ? find(open.id) : undefined;
  const archiving = archivingId ? find(archivingId) : undefined;
  const active = agents.filter((a) => !a.archived);
  const archived = agents.filter((a) => a.archived);
  const shown = view === "active" ? active : archived;
  const full = active.length >= MAX_AGENTS;

  const showNew = (agent: AgentView, tab: AgentTab) => {
    setMade(agent);
    setView("active");
    setOpen({ id: agent.id, tab });
  };

  return (
    <div>
      <SettingsHeader title={t("heading")} description={t("description")} />
      <CreationSetting workspaceId={workspaceId} value={creation} canEdit={isOwner} />
      <hr className="my-6 border-border" />
      <div className="space-y-3">
        {ai !== "on" && (
          <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
            {t(ai === "off" ? "aiOff" : "aiUnavailable")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {(isOwner || archived.length > 0) && (
            <div role="tablist" aria-label={t("heading")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
              <TabButton active={view === "active"} onClick={() => setView("active")}>
                {t("tabs.active")} <span className="text-fg-faint">{active.length}</span>
              </TabButton>
              <TabButton active={view === "archived"} onClick={() => setView("archived")}>
                {t("tabs.archived")} <span className="text-fg-faint">{archived.length}</span>
              </TabButton>
            </div>
          )}
          {canCreate && ai === "on" && (
            <Button className="ms-auto" disabled={full} onClick={() => setDescribing(true)}>
              <Sparkles className="h-3.5 w-3.5" />
              {t("describe.button")}
            </Button>
          )}
          {canCreate && (
            <Button
              variant="primary"
              className={ai === "on" ? undefined : "ms-auto"}
              disabled={full}
              title={full ? t("errors.tooMany", { max: MAX_AGENTS }) : undefined}
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("newButton")}
            </Button>
          )}
        </div>
        {!canCreate && <p className="text-xs text-fg-muted">{t("ownersOnly")}</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <div className="overflow-hidden rounded-xl border border-border">
          {shown.length ? (
            <ul className={cn("divide-y divide-border", pending && "opacity-70")}>
              {shown.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  proposals={proposals[agent.id] ?? 0}
                  onOpen={(tab) => setOpen({ id: agent.id, tab })}
                  onToggle={() => run(() => updateAgentAction(workspaceId, agent.id, { enabled: !agent.enabled }))}
                  onArchive={() => setArchivingId(agent.id)}
                  onRestore={() => run(() => restoreAgentAction(workspaceId, agent.id))}
                  onDuplicate={
                    canCreate && editsAgent(agent) && !full
                      ? () =>
                          run(
                            () => duplicateAgentAction(workspaceId, agent.id),
                            ({ agent: copy, leftOut }) => {
                              setCopied({ id: copy.id, from: agent.name, leftOut });
                              showNew(copy, "settings");
                            },
                          )
                      : undefined
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">
              {view === "archived" ? t("emptyArchived") : canCreate ? t("emptyOwner") : t("empty")}
            </p>
          )}
        </div>
        {view === "archived" && archived.length > 0 && <p className="text-xs text-fg-muted">{t("restoreHint")}</p>}
      </div>

      {canCreate && templates.length > 0 && (
        <SettingsGroup anchor="agentTemplates" title={t("templates.heading")} description={t("templates.description")} className="mt-10">
          <ul className="divide-y divide-border">
            {templates.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => setTemplate(item)}
                  className="flex w-full items-start gap-3 px-5 py-3 text-start hover:bg-bg-hover disabled:opacity-50"
                >
                  <span className="mt-0.5 text-lg leading-none">{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="block text-sm text-fg-muted">{item.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}

      {creating && (
        <Dialog open onClose={() => setCreating(false)} className="max-w-2xl">
          <DialogHeader title={t("form.createTitle")} onClose={() => setCreating(false)} closeLabel={tc("close")} />
          <AgentForm
            workspaceId={workspaceId}
            isOwner={isOwner}
            models={models}
            webSearch={webSearch}
            onDone={() => setCreating(false)}
            onCreated={(agent) => {
              setCreating(false);
              // Next: what it may open.
              showNew(agent, "access");
            }}
          />
        </Dialog>
      )}
      {describing && (
        <AgentDescribeDialog
          workspaceId={workspaceId}
          isOwner={isOwner}
          models={models}
          webSearch={webSearch}
          onClose={() => setDescribing(false)}
          onCreated={(agent) => {
            setDescribing(false);
            showNew(agent, "settings");
          }}
        />
      )}
      {opened && open && (
        <AgentDialog
          workspaceId={workspaceId}
          isOwner={isOwner}
          agent={opened}
          tab={open.tab}
          runId={linkedRun}
          proposals={proposals[opened.id] ?? 0}
          memoryOff={memoryOff}
          models={models}
          webSearch={webSearch}
          notice={copied?.id === opened.id ? <CopyNotice from={copied.from} leftOut={copied.leftOut} /> : undefined}
          onTab={(tab) => setOpen({ id: opened.id, tab })}
          onOpenRun={(agentId, runId) => {
            if (!find(agentId)) return;
            setLinkedRun(runId);
            setOpen({ id: agentId, tab: "runs" });
          }}
          onClose={() => {
            setOpen(null);
            setCopied(null);
            if (!initialAgentId) return;
            // A reload shouldn't open it again.
            setLinkedRun(undefined);
            const url = new URL(window.location.href);
            url.searchParams.delete("agent");
            url.searchParams.delete("run");
            url.searchParams.delete("agentTab");
            window.history.replaceState(null, "", url);
          }}
        />
      )}
      {archiving && <ArchiveDialog workspaceId={workspaceId} agent={archiving} onClose={() => setArchivingId(null)} />}
      {template && (
        <TemplateWizard
          workspaceId={workspaceId}
          template={template}
          onClose={() => setTemplate(null)}
          onCreated={(agent) => {
            setTemplate(null);
            showNew(agent, "settings");
          }}
        />
      )}
    </div>
  );
}

function AgentRow({
  agent,
  proposals,
  onOpen,
  onToggle,
  onArchive,
  onRestore,
  onDuplicate,
}: {
  agent: AgentView;
  proposals: number;
  onOpen: (tab: AgentTab) => void;
  onToggle: () => void;
  onArchive: () => void;
  onRestore: () => void;
  /** Copies it; absent when the viewer may not (they can't create agents or edit this one, or there are as many as there may be). */
  onDuplicate?: () => void;
}) {
  const t = useTranslations("settings.agents");
  const menu = useFloating<HTMLButtonElement>();
  const status = agent.archived ? "archived" : agent.enabled ? "active" : "paused";
  const full = hasAgentLevel(agent.access, "full");
  const item = (label: string, action: () => void, danger = false) => (
    <MenuItem
      danger={danger}
      onClick={() => {
        menu.close();
        action();
      }}
    >
      {label}
    </MenuItem>
  );
  const name = (
    <>
      <span className={cn("block truncate font-medium", status !== "active" && "text-fg-muted")}>{agent.name}</span>
      {agent.description && <span className="block truncate text-xs text-fg-muted">{agent.description}</span>}
    </>
  );
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-lg">
        <AgentIcon icon={agent.icon} />
      </span>
      <button type="button" onClick={() => onOpen("settings")} className="min-w-0 flex-1 text-start hover:[&>span:first-child]:underline">
        {name}
      </button>
      {proposals > 0 && (
        <button
          type="button"
          onClick={() => onOpen("memory")}
          aria-label={t("memory.toReview", { count: proposals })}
          className="shrink-0 text-xs font-medium text-accent hover:underline"
        >
          {/* A phone has room for the count only, beside the agent's name. */}
          <span className="hidden sm:inline">{t("memory.toReview", { count: proposals })}</span>
          <span className="rounded bg-accent px-1 text-accent-fg tabular-nums sm:hidden">{proposals}</span>
        </button>
      )}
      <span className={cn("shrink-0 text-xs", status === "active" ? "text-fg" : "text-fg-muted")}>{t(`status.${status}`)}</span>
      <IconButton ref={menu.ref} label={t("actionsFor", { name: agent.name })} onClick={menu.toggle}>
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-start">
        {agent.archived ? (
          <>
            {item(t("tabs.runs"), () => onOpen("runs"))}
            {onDuplicate && item(t("duplicate"), onDuplicate)}
            {/* Archiving and restoring take full access. */}
            {full && item(t("restore"), onRestore)}
          </>
        ) : (
          <>
            {item(t("tabs.settings"), () => onOpen("settings"))}
            {item(t("tabs.access"), () => onOpen("access"))}
            {item(t("tabs.memory"), () => onOpen("memory"))}
            {item(t("tabs.schedules"), () => onOpen("schedules"))}
            {item(t("tabs.runs"), () => onOpen("runs"))}
            {item(t("share.button"), () => onOpen("share"))}
            {onDuplicate && item(t("duplicate"), onDuplicate)}
            {editsAgent(agent) && item(agent.enabled ? t("pause") : t("resume"), onToggle)}
            {full && (
              <>
                <MenuSeparator />
                {item(t("archive"), onArchive, true)}
              </>
            )}
          </>
        )}
      </Floating>
    </li>
  );
}

/** What a copy took from the agent it copies, and what it left out. */
function CopyNotice({ from, leftOut }: { from: string; leftOut: CopyLeftOut }) {
  const t = useTranslations("settings.agents.copy");
  return (
    <div className="space-y-1">
      <p>{t("done", { name: from })}</p>
      {leftOut.skills && <p>{t("skillsLeftOut", { count: leftOut.skills })}</p>}
      {leftOut.helpers && <p>{t("helpersLeftOut", { count: leftOut.helpers })}</p>}
      {leftOut.connections && <p>{t("connectionsLeftOut", { count: leftOut.connections })}</p>}
    </div>
  );
}

function ArchiveDialog({ workspaceId, agent, onClose }: { workspaceId: string; agent: AgentView; onClose: () => void }) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogBody className="pt-5">
        <div className="space-y-1.5">
          <DialogTitle>{t("archiveTitle", { name: agent.name })}</DialogTitle>
          <p className="text-sm text-fg-muted">{t("archiveBody")}</p>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => run(() => archiveAgentAction(workspaceId, agent.id), onClose)}>
          {t("archive")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Who may create agents: owners only, owners and members, or owners and the people and groups
 * chosen (never guests). Owners change it, and pick the people and groups.
 */
function CreationSetting({ workspaceId, value: initial, canEdit }: { workspaceId: string; value: AgentCreation; canEdit: boolean }) {
  const t = useTranslations("settings.agents.creation");
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const { pending, error, run } = useAction();

  return (
    <div id={settingAnchor("agentCreation")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <label htmlFor="agent-creation" className="block text-sm font-medium">
            {t("who")}
          </label>
          <div className="mt-1 text-sm text-fg-muted">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              <>
                {t("whoHelp")}
                {!canEdit && <> {t("ownersOnly")}</>}
              </>
            )}
          </div>
        </div>
        <select
          id="agent-creation"
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.value as AgentCreation;
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { agentCreation: next });
              if (!result.ok) setValue(previous);
              else router.refresh();
              return result;
            });
          }}
          className={cn(selectClass, "shrink-0")}
        >
          {AGENT_CREATIONS.map((choice) => (
            <option key={choice} value={choice}>
              {t(`choices.${choice}`)}
            </option>
          ))}
        </select>
      </div>
      {value === "chosen" && canEdit && (
        <div className="mt-3">
          <AgentCreatorsList workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}

"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { archiveAgentAction, restoreAgentAction, updateAgentAction } from "@/app/actions/agents";
import { Floating, useFloating } from "@/components/database/floating";
import { TabButton } from "@/components/settings/members-panel";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, MenuItem, MenuSeparator } from "@/components/ui";
import { MAX_AGENTS, type AgentView } from "@/lib/agents";
import type { BuiltinAgentSummary } from "@/lib/builtin-agents";
import { AgentDialog, AgentForm, AgentIcon, type AgentTab } from "./agent-dialog";
import { TemplateWizard } from "./agent-template-wizard";

/**
 * Settings > Agents: the workspace's agents, active or archived. Owners create them (from scratch
 * or from a template), open one to change it, choose the pages it may open and read its runs,
 * pause, archive and restore them; members see the list.
 */
export function AgentsPanel({
  workspaceId,
  isOwner,
  agents,
  templates,
  ai,
  initialAgentId,
  initialRunId,
}: {
  workspaceId: string;
  isOwner: boolean;
  /** Archived ones too, for owners. */
  agents: AgentView[];
  templates: BuiltinAgentSummary[];
  /** Whether agents can run: AI set up on the server and on in the workspace. */
  ai: "on" | "off" | "unavailable";
  initialAgentId?: string;
  initialRunId?: string;
}) {
  const t = useTranslations("settings.agents");
  const [view, setView] = useState<"active" | "archived">(() =>
    agents.find((a) => a.id === initialAgentId)?.archived ? "archived" : "active",
  );
  const [open, setOpen] = useState<{ id: string; tab: AgentTab } | null>(() =>
    initialAgentId && agents.some((a) => a.id === initialAgentId) ? { id: initialAgentId, tab: initialRunId ? "runs" : "settings" } : null,
  );
  // An agent just made, until the refreshed list brings it.
  const [made, setMade] = useState<AgentView | null>(null);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
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
      <div className="space-y-3">
        {ai !== "on" && (
          <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">
            {t(ai === "off" ? "aiOff" : "aiUnavailable")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isOwner && (
            <div role="tablist" aria-label={t("heading")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
              <TabButton active={view === "active"} onClick={() => setView("active")}>
                {t("tabs.active")} <span className="text-fg-faint">{active.length}</span>
              </TabButton>
              <TabButton active={view === "archived"} onClick={() => setView("archived")}>
                {t("tabs.archived")} <span className="text-fg-faint">{archived.length}</span>
              </TabButton>
            </div>
          )}
          {isOwner && (
            <Button
              variant="primary"
              className="ml-auto"
              disabled={full}
              title={full ? t("errors.tooMany", { max: MAX_AGENTS }) : undefined}
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("newButton")}
            </Button>
          )}
        </div>
        {!isOwner && <p className="text-xs text-fg-muted">{t("ownersOnly")}</p>}
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
                  isOwner={isOwner}
                  onOpen={(tab) => setOpen({ id: agent.id, tab })}
                  onToggle={() => run(() => updateAgentAction(workspaceId, agent.id, { enabled: !agent.enabled }))}
                  onArchive={() => setArchivingId(agent.id)}
                  onRestore={() => run(() => restoreAgentAction(workspaceId, agent.id))}
                />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">
              {view === "archived" ? t("emptyArchived") : isOwner ? t("emptyOwner") : t("empty")}
            </p>
          )}
        </div>
        {view === "archived" && archived.length > 0 && <p className="text-xs text-fg-muted">{t("restoreHint")}</p>}
      </div>

      {isOwner && templates.length > 0 && (
        <SettingsGroup title={t("templates.heading")} description={t("templates.description")} className="mt-10">
          <ul className="divide-y divide-border">
            {templates.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => setTemplate(item)}
                  className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-bg-hover disabled:opacity-50"
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
          <h2 className="border-b border-border px-5 py-4 text-base font-semibold">{t("form.createTitle")}</h2>
          <AgentForm
            workspaceId={workspaceId}
            onDone={() => setCreating(false)}
            onCreated={(agent) => {
              setCreating(false);
              // Next: what it may open.
              showNew(agent, "access");
            }}
          />
        </Dialog>
      )}
      {opened && open && (
        <AgentDialog
          workspaceId={workspaceId}
          agent={opened}
          tab={open.tab}
          runId={linkedRun}
          onTab={(tab) => setOpen({ id: opened.id, tab })}
          onClose={() => {
            setOpen(null);
            if (!initialAgentId) return;
            // A reload shouldn't open it again.
            setLinkedRun(undefined);
            const url = new URL(window.location.href);
            url.searchParams.delete("agent");
            url.searchParams.delete("run");
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
  isOwner,
  onOpen,
  onToggle,
  onArchive,
  onRestore,
}: {
  agent: AgentView;
  isOwner: boolean;
  onOpen: (tab: AgentTab) => void;
  onToggle: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useTranslations("settings.agents");
  const menu = useFloating<HTMLButtonElement>();
  const status = agent.archived ? "archived" : agent.enabled ? "active" : "paused";
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
      {isOwner ? (
        <button type="button" onClick={() => onOpen("settings")} className="min-w-0 flex-1 text-left hover:[&>span:first-child]:underline">
          {name}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{name}</div>
      )}
      <span className={cn("shrink-0 text-xs", status === "active" ? "text-fg" : "text-fg-muted")}>{t(`status.${status}`)}</span>
      {isOwner && (
        <>
          <IconButton ref={menu.ref} label={t("actionsFor", { name: agent.name })} onClick={menu.toggle}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
          <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-left">
            {agent.archived ? (
              <>
                {item(t("tabs.runs"), () => onOpen("runs"))}
                {item(t("restore"), onRestore)}
              </>
            ) : (
              <>
                {item(t("tabs.settings"), () => onOpen("settings"))}
                {item(t("tabs.access"), () => onOpen("access"))}
                {item(t("tabs.runs"), () => onOpen("runs"))}
                {item(agent.enabled ? t("pause") : t("resume"), onToggle)}
                <MenuSeparator />
                {item(t("archive"), onArchive, true)}
              </>
            )}
          </Floating>
        </>
      )}
    </li>
  );
}

function ArchiveDialog({ workspaceId, agent, onClose }: { workspaceId: string; agent: AgentView; onClose: () => void }) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{t("archiveTitle", { name: agent.name })}</h2>
        <p className="text-sm text-fg-muted">{t("archiveBody")}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="danger" disabled={pending} onClick={() => run(() => archiveAgentAction(workspaceId, agent.id), onClose)}>
            {t("archive")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

"use client";

import { ChevronRight, Eye, Info, MessageSquare, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { lazyPart } from "@/components/lazy-part";
import { buttonClass, cn, Popover } from "@/components/ui";
import { agentPagePath } from "@/lib/agent-page";
import { agentSettingsPath, isAgentSection, type AgentSection, type AgentTab } from "@/lib/agent-settings";
import { editsAgent, type AgentView } from "@/lib/agents";
import { takeCopy, type CopyNote } from "./agent-copy-note";
import { AgentConnectionsTab } from "./agent-connections-tab";
import { AccessTab, AgentForm, AgentIcon, RunsTab, type AgentModelNames } from "./agent-dialog";
import { AgentHistoryTab } from "./agent-history-tab";
import { AgentSchedulesTab } from "./agent-schedules-tab";
import { AgentSkillsTab } from "./agent-skills-tab";

const loading = <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-hover" />;
const AgentShareTab = lazyPart(() => import("./agent-share-tab").then((m) => m.AgentShareTab), loading);
const AgentTriggersTab = lazyPart(() => import("./agent-triggers-tab").then((m) => m.AgentTriggersTab), loading);
const AgentMemoryTab = lazyPart(() => import("./agent-memory-tab").then((m) => m.AgentMemoryTab), loading);

/** The list down the page's side: its settings, then what it did. Sharing opens from the top bar. */
const NAV: readonly (readonly AgentSection[])[] = [
  ["settings", "skills", "memory", "tools", "access", "connections", "triggers", "schedules", "advanced"],
  ["runs", "history"],
];
/** Sections whose content is a list or table that takes the page's width, not a form's. */
const WIDE: readonly AgentSection[] = ["runs", "history", "connections"];

/**
 * An agent's settings page: who it is at the top, its sections down the side and one of them
 * beside it (`?section=`, changed in place without a server round trip). What the viewer may
 * change follows their level on it (`agent.access`): those who can view and interact see every
 * section read-only and their own runs alone. `?run=` opens one of its runs (a link from the inbox
 * or an automation's history).
 */
export function AgentEditor({
  workspaceId,
  isOwner,
  agent,
  proposals,
  memoryOff,
  models,
  webSearch,
}: {
  workspaceId: string;
  /** The viewer owns the workspace: they choose the connections' tools and the token limit, and answer calls. */
  isOwner: boolean;
  agent: AgentView;
  /** Notes its runs proposed that wait for an owner. */
  proposals: number;
  memoryOff: boolean;
  /** The models an agent may choose between; null hides the choice (see AgentForm). */
  models: AgentModelNames | null;
  /** The server has a search service (see AgentForm). */
  webSearch: boolean;
}) {
  const t = useTranslations("settings.agents");
  const router = useRouter();
  const params = useSearchParams();
  const asked = params.get("section");
  const section: AgentSection = isAgentSection(asked) ? asked : params.get("run") ? "runs" : "settings";
  const [copy, setCopy] = useState<CopyNote | null>(null);
  useEffect(() => setCopy(takeCopy(agent.id)), [agent.id]);

  const go = (tab: AgentTab) => {
    if (tab === "chat") return router.push(agentPagePath(workspaceId, agent.id));
    // Next follows the address: the section changes without asking the server again.
    window.history.pushState(null, "", agentSettingsPath(workspaceId, agent.id, tab));
  };
  const status = agent.archived ? "archived" : agent.enabled ? "active" : "paused";
  const label = (name: AgentSection) =>
    name === "settings" || name === "triggers" || name === "advanced"
      ? t(`sections.${name === "settings" ? "instructions" : name}`)
      : name === "tools" || name === "share"
        ? t(`nav.${name === "tools" ? "tools" : "sharing"}`)
        : t(`tabs.${name}`);

  return (
    <div data-filled-fields className="mx-auto w-full max-w-[1040px] px-4 pt-14 pb-16 md:px-8 md:pt-2">
      <div className="flex h-11 items-center gap-1 text-sm text-fg-muted">
        <Link href={`/w/${workspaceId}/settings?tab=agents`} className="shrink-0 rounded-md px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
          {t("heading")}
        </Link>
        <ChevronRight className="h-3 w-3 shrink-0 rtl:rotate-180" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg">{agent.name}</span>
        {!agent.archived && (
          <Link href={agentPagePath(workspaceId, agent.id)} className={buttonClass({ variant: "ghost" })}>
            <MessageSquare className="h-4 w-4" />
            <span className="max-sm:sr-only">{t("tabs.chat")}</span>
          </Link>
        )}
        <button type="button" aria-pressed={section === "share"} onClick={() => go("share")} className={cn(buttonClass({ variant: "ghost" }), section === "share" && "bg-bg-hover text-fg")}>
          <Users className="h-4 w-4" />
          <span className="max-sm:sr-only">{t("share.button")}</span>
        </button>
      </div>

      <header className="mt-4 md:mt-6">
        <div className="flex items-center gap-3">
          <AgentIcon icon={agent.icon} className="h-7 w-7 shrink-0 text-[28px] leading-none" />
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-fg-muted">
            <span className={cn("h-[7px] w-[7px] rounded-full", status === "active" ? "bg-accent" : "bg-fg-faint")} aria-hidden />
            {t(`status.${status}`)}
          </span>
        </div>
        {agent.description && <p className="mt-1.5 max-w-[640px] text-sm text-fg-muted">{agent.description}</p>}
        {copy && (
          <div role="status" className="mt-4 max-w-[640px] space-y-1 rounded-lg bg-bg-subtle px-4 py-3 text-[13px] text-fg-muted">
            <CopyNotice note={copy} />
          </div>
        )}
        {!editsAgent(agent) && section !== "share" && (
          <p className="mt-3 flex max-w-[640px] gap-2 text-[13px] text-fg-muted">
            <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("viewOnly")}
          </p>
        )}
      </header>

      <div className="mt-6 flex flex-col gap-6 md:mt-8 md:flex-row md:gap-12">
        {/* A phone has no room beside the section: the list is a row that scrolls on its own. */}
        <nav
          aria-label={agent.name}
          className="-mx-4 flex shrink-0 gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] md:sticky md:top-4 md:mx-0 md:w-[188px] md:flex-col md:self-start md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {NAV.map((group, i) => (
            <div key={i} className="contents">
              {i > 0 && <div className="shrink-0 px-2 pt-4 pb-1 text-xs text-fg-faint max-md:hidden">{t("nav.activity")}</div>}
              {i > 0 && <span className="mx-1 my-1.5 w-px shrink-0 bg-border md:hidden" aria-hidden />}
              {group.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-current={section === name ? "page" : undefined}
                  onClick={() => go(name)}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-start text-sm whitespace-nowrap",
                    section === name ? "bg-bg-hover font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{label(name)}</span>
                  {name === "memory" && proposals > 0 && (
                    <span className="rounded bg-accent px-1 text-xs font-medium text-accent-fg tabular-nums" aria-label={t("memory.waiting", { count: proposals })}>
                      {proposals}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section aria-label={label(section)} className={cn("min-w-0 flex-1", !WIDE.includes(section) && "max-w-[640px]")}>
          {/* Memory's warning line follows its help line closely. */}
          <div className={section === "memory" ? "mb-3" : "mb-6"}>
            <div className="flex items-center gap-1.5">
              <h2 className="text-base font-semibold">{label(section)}</h2>
              {section === "memory" && (
                <InfoButton label={t("memory.about")}>
                  <p>{t("memory.description")}</p>
                  <p>{t("memory.rule")}</p>
                </InfoButton>
              )}
            </div>
            {section === "memory" && <p className="mt-1 text-[13px] text-fg-muted">{t("memory.help")}</p>}
          </div>
          {section === "share" ? (
            <AgentShareTab workspaceId={workspaceId} agent={agent} />
          ) : section === "settings" || section === "tools" || section === "advanced" ? (
            <AgentForm
              key={section}
              workspaceId={workspaceId}
              agent={agent}
              isOwner={isOwner}
              models={models}
              webSearch={webSearch}
              part={section === "settings" ? "instructions" : section}
              onDone={() => router.refresh()}
            />
          ) : section === "access" ? (
            <AccessTab workspaceId={workspaceId} agent={agent} />
          ) : section === "skills" ? (
            <AgentSkillsTab workspaceId={workspaceId} agent={agent} />
          ) : section === "memory" ? (
            <AgentMemoryTab workspaceId={workspaceId} agent={agent} memoryOff={memoryOff} />
          ) : section === "connections" ? (
            <AgentConnectionsTab workspaceId={workspaceId} agent={agent} isOwner={isOwner} />
          ) : section === "triggers" ? (
            <AgentTriggersTab workspaceId={workspaceId} agent={agent} onTab={go} />
          ) : section === "schedules" ? (
            <AgentSchedulesTab workspaceId={workspaceId} agent={agent} onRuns={() => go("runs")} />
          ) : section === "history" ? (
            <AgentHistoryTab workspaceId={workspaceId} agent={agent} />
          ) : (
            <RunsTab
              workspaceId={workspaceId}
              agent={agent}
              isOwner={isOwner}
              runId={params.get("run") ?? undefined}
              onOpenRun={(otherId, otherRun) => router.push(agentSettingsPath(workspaceId, otherId, "runs", otherRun))}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** An info button beside a section's title: what the one line under it leaves out. */
function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button type="button" aria-label={label} title={label} aria-expanded={open} onClick={toggle} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-faint hover:bg-bg-hover hover:text-fg">
          <Info className="h-4 w-4" />
        </button>
      )}
      className="w-80 max-w-[calc(100vw-2rem)] space-y-2 p-3 text-[13px] text-fg-muted"
    >
      {children}
    </Popover>
  );
}

/** What a copy took from the agent it copies, and what it left out. */
function CopyNotice({ note: { from, leftOut } }: { note: CopyNote }) {
  const t = useTranslations("settings.agents.copy");
  return (
    <>
      <p>{t("done", { name: from })}</p>
      {leftOut.skills && <p>{t("skillsLeftOut", { count: leftOut.skills })}</p>}
      {leftOut.helpers && <p>{t("helpersLeftOut", { count: leftOut.helpers })}</p>}
      {leftOut.connections && <p>{t("connectionsLeftOut", { count: leftOut.connections })}</p>}
    </>
  );
}

"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { bindExternalAgentAction, externalAgentOverviewAction, unbindExternalAgentAction } from "@/app/actions/external-agents";
import { lazyPart } from "@/components/lazy-part";
import { Button, cn, selectClass } from "@/components/ui";
import { claudeCodeAddCommand, workCurl } from "@/lib/external-agents";
import { agentSettingsPath } from "@/lib/agent-settings";
import { editsAgent, type AgentView } from "@/lib/agents";
import type { ExternalAgentOverview } from "@/server/agents/external";
import { AgentIcon } from "./agent-dialog";
import { SecretBox, useOwnApps } from "./external-agent-dialog";
import { useAction } from "./workspace-settings";

const AgentShareTab = lazyPart(() => import("./agent-share-tab").then((m) => m.AgentShareTab), <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-hover" />);

type Tab = "work" | "connection" | "setup" | "share";
const isTab = (value: string | null): value is Tab => value === "work" || value === "connection" || value === "setup" || value === "share";

/**
 * An outside agent's page (kind `external`, server/agents/external.ts): the work it has in hand and
 * what it did last, how it is reached (a connected app or a token of its own), how to wire an MCP client up
 * to it, and who it is shared with. It has no instructions, tools or runs: it never runs here.
 */
export function ExternalAgentEditor({
  workspaceId,
  agent,
  overview: first,
  mcpUrl,
  apiUrl,
}: {
  workspaceId: string;
  agent: AgentView;
  overview: ExternalAgentOverview;
  mcpUrl: string;
  apiUrl: string;
}) {
  const t = useTranslations("settings.agents");
  const te = useTranslations("settings.agents.external");
  const asked = useSearchParams().get("section");
  const [overview, setOverview] = useState(first);
  const manages = agent.access === "full" && !agent.archived;
  const reload = () => {
    externalAgentOverviewAction(workspaceId, agent.id)
      .then((res) => res.ok && setOverview(res.data))
      .catch(() => undefined);
  };
  const tabs: Tab[] = editsAgent(agent) ? ["work", "connection", "setup", "share"] : ["work", "share"];
  const tab: Tab = isTab(asked) && tabs.includes(asked) ? asked : "work";
  // The section is in the address, changed in place without a server round trip.
  const go = (name: Tab) => window.history.pushState(null, "", name === "work" ? agentSettingsPath(workspaceId, agent.id) : `${agentSettingsPath(workspaceId, agent.id)}?section=${name}`);
  const status = agent.archived ? "archived" : agent.enabled ? "active" : "paused";

  return (
    <div data-filled-fields className="mx-auto w-full max-w-[1040px] px-4 pt-14 pb-16 md:px-8 md:pt-2">
      <div className="flex h-11 items-center gap-1 text-sm text-fg-muted">
        <Link href={`/w/${workspaceId}/settings?tab=agents`} className="shrink-0 rounded-md px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
          {t("heading")}
        </Link>
        <ChevronRight className="h-3 w-3 shrink-0 rtl:rotate-180" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg">{agent.name}</span>
      </div>
      <header className="mt-4 md:mt-6">
        <div className="flex items-center gap-3">
          <AgentIcon icon={agent.icon} className="h-7 w-7 shrink-0 text-[28px] leading-none" />
          <h1 className="min-w-0 truncate font-display text-2xl tracking-tight">{agent.name}</h1>
          <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-xs text-fg-muted">{te("badge")}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-fg-muted">
            <span className={cn("h-[7px] w-[7px] rounded-full", status === "active" ? "bg-accent" : "bg-fg-faint")} aria-hidden />
            {t(`status.${status}`)}
          </span>
        </div>
        {agent.description && <p className="mt-1.5 max-w-[640px] text-sm text-fg-muted">{agent.description}</p>}
      </header>

      <div className="mt-6 flex flex-col gap-6 md:mt-8 md:flex-row md:gap-12">
        <nav aria-label={agent.name} className="-mx-4 flex shrink-0 gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] md:sticky md:top-4 md:mx-0 md:w-[188px] md:flex-col md:self-start md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              aria-current={tab === name ? "page" : undefined}
              onClick={() => go(name)}
              className={cn("flex h-8 shrink-0 items-center rounded-md px-2 text-start text-sm whitespace-nowrap", tab === name ? "bg-bg-hover font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg")}
            >
              {te(`tab.${name}`)}
            </button>
          ))}
        </nav>

        <section className="min-w-0 max-w-[640px] flex-1">
          {tab === "work" && <WorkTab workspaceId={workspaceId} overview={overview} />}
          {tab === "connection" && <ConnectionTab workspaceId={workspaceId} agent={agent} overview={overview} manages={manages} onChanged={reload} />}
          {tab === "setup" && <SetupTab agent={agent} mcpUrl={mcpUrl} apiUrl={apiUrl} />}
          {tab === "share" && <AgentShareTab workspaceId={workspaceId} agent={agent} />}
        </section>
      </div>
    </div>
  );
}

function WorkTab({ workspaceId, overview }: { workspaceId: string; overview: ExternalAgentOverview }) {
  const te = useTranslations("settings.agents.external");
  const format = useFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-2 text-base font-semibold">{te("workTitle")}</h2>
        {overview.work.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {overview.work.map((row) => (
              <li key={row.id}>
                <Link href={`/w/${workspaceId}/p/${row.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-bg-hover">
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  {row.databaseTitle && <span className="hidden max-w-40 truncate text-xs text-fg-muted sm:block">{row.databaseTitle}</span>}
                  {row.status && <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-xs">{row.status}</span>}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{te("workEmpty")}</p>
        )}
      </div>
      <div>
        <h2 className="mb-2 text-base font-semibold">{te("mentionsTitle")}</h2>
        {overview.mentions.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {overview.mentions.map((m) => (
              <li key={m.id}>
                <Link href={`/w/${workspaceId}/p/${m.pageId}`} className="block px-4 py-2.5 text-sm hover:bg-bg-hover">
                  <span className="block truncate font-medium">{m.pageTitle}</span>
                  <span className="block truncate text-fg-muted">{m.text}</span>
                  <span className="block text-xs text-fg-faint">{when(m.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{te("mentionsEmpty")}</p>
        )}
      </div>
      <div>
        <h2 className="mb-2 text-base font-semibold">{te("activityTitle")}</h2>
        {overview.activity.length ? (
          <ul className="space-y-1.5 text-sm">
            {overview.activity.map((a, i) => (
              <li key={`${a.rowId}-${i}`} className="flex gap-2">
                <Link href={`/w/${workspaceId}/p/${a.rowId}`} className="min-w-0 flex-1 truncate hover:underline">
                  {a.title}
                </Link>
                <span className="shrink-0 text-xs text-fg-muted">{when(a.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{te("activityEmpty")}</p>
        )}
      </div>
    </div>
  );
}

function ConnectionTab({ workspaceId, agent, overview, manages, onChanged }: { workspaceId: string; agent: AgentView; overview: ExternalAgentOverview; manages: boolean; onChanged: () => void }) {
  const te = useTranslations("settings.agents.external");
  const format = useFormatter();
  const apps = useOwnApps();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  const binding = overview.binding;
  const app = clientId || apps?.[0]?.clientId || "";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-2 text-base font-semibold">{te("connectionTitle")}</h2>
        {binding ? (
          <div className="space-y-1 text-sm">
            <p>{binding.via === "app" ? te("boundApp", { app: binding.name, person: binding.person ?? "" }) : te("boundToken", { token: binding.name })}</p>
            <p className="text-fg-muted">
              {binding.lastUsedAt
                ? te("lastUsed", { when: format.dateTime(new Date(binding.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }), tool: binding.lastTool ?? "" })
                : te("neverUsed")}
            </p>
            {!binding.holds && <p className="text-danger">{te("broken")}</p>}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">{te("notBound")}</p>
        )}
      </div>
      {manages && (
        <fieldset disabled={pending} className="space-y-3">
          {secret && (
            <div className="space-y-2">
              <p className="text-sm text-fg-muted">{te("tokenHelp")}</p>
              <SecretBox secret={secret} />
            </div>
          )}
          {apps && apps.length > 0 && (
            <div className="flex items-end gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-xs font-medium text-fg-muted">{te("appLabel")}</span>
                <select className={selectClass} value={app} onChange={(e) => setClientId(e.target.value)}>
                  {apps.map((a) => (
                    <option key={a.clientId} value={a.clientId}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                onClick={() =>
                  run(() => bindExternalAgentAction(workspaceId, agent.id, { kind: "app", clientId: app }), () => {
                    setSecret(null);
                    onChanged();
                  })
                }
              >
                {te("rebindApp")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                run(() => bindExternalAgentAction(workspaceId, agent.id, { kind: "token" }), ({ secret: made }) => {
                  setSecret(made);
                  onChanged();
                })
              }
            >
              {te("newToken")}
            </Button>
            {binding && (
              <Button
                variant="secondary"
                onClick={() =>
                  run(() => unbindExternalAgentAction(workspaceId, agent.id), () => {
                    setSecret(null);
                    onChanged();
                  })
                }
              >
                {te("unbind")}
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}

function SetupTab({ agent, mcpUrl, apiUrl }: { agent: AgentView; mcpUrl: string; apiUrl: string }) {
  const te = useTranslations("settings.agents.external");
  const block = (text: string) => <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs">{text}</pre>;
  return (
    <div className="space-y-6 text-sm">
      <p className="text-fg-muted">{te("setupIntro")}</p>
      <div className="space-y-2">
        <h2 className="text-base font-semibold">{te("setupClaude")}</h2>
        <p className="text-fg-muted">{te("setupClaudeHelp")}</p>
        {block(claudeCodeAddCommand(agent.name, mcpUrl))}
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-semibold">{te("setupRest")}</h2>
        <p className="text-fg-muted">{te("setupRestHelp")}</p>
        {block(workCurl(apiUrl))}
      </div>
      <p className="text-fg-muted">{te("setupLimits")}</p>
    </div>
  );
}

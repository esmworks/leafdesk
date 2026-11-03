"use client";

import { Bot, Settings2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { IconGlyph } from "@/components/builtin-icon";
import { lazyPart } from "@/components/lazy-part";
import { SIDE_HIDDEN } from "@/lib/side-layout";
import { buttonClass, cn } from "@/components/ui";
import { agentPath } from "@/lib/agent-chat";
import type { AgentScheduleView } from "@/lib/agents";

const AgentChat = lazyPart(
  () => import("@/components/agent-chat/agent-thread").then((m) => m.AgentChat),
  <div aria-busy="true" className="m-6 h-24 animate-pulse rounded-md bg-bg-subtle" />,
);
// Only for an agent with schedules, on a wide page.
const Schedules = lazyPart(() => import("@/components/agent-chat/agent-schedules-box").then((m) => m.AgentSchedulesBox));

type Agent = { id: string; name: string; icon: string | null; description: string };

/**
 * An agent's own page, which the sidebar opens: a chat with it, the AI chat's thread and box, with
 * where it is in the bar on top and the way to its settings, a page of their own (agent-editor.tsx),
 * at that bar's end. On a narrow page who it is shows above the messages; on a wide page its
 * schedules and, once the chat loads, its runs and what they changed (the chat adds those itself)
 * show in boxes beside the chat.
 */
export function AgentPage({
  workspaceId,
  agent,
  schedules,
  focusRun,
}: {
  workspaceId: string;
  agent: Agent;
  schedules: AgentScheduleView[];
  focusRun: string | null;
}) {
  const t = useTranslations("settings.agents");
  const tSidebar = useTranslations("sidebar");
  const crumbs = (
    <nav className="flex min-w-0 items-center gap-1 text-sm text-fg-muted">
      <span className="flex shrink-0 items-center gap-1 px-1 max-md:hidden">
        {tSidebar("sections.agents")}
        <span className="text-fg-faint">/</span>
      </span>
      <span title={agent.description || undefined} className="flex min-w-0 items-center gap-1 px-1 py-0.5 text-fg">
        <span className="text-sm">
          <AgentGlyph icon={agent.icon} />
        </span>
        <span className="truncate md:max-w-60">{agent.name}</span>
      </span>
    </nav>
  );
  const settings = (
    <Link href={agentPath(workspaceId, agent.id)} className={cn(buttonClass({ variant: "ghost" }), "h-7 px-2 font-normal text-fg-muted hover:text-fg")}>
      <Settings2 className="h-4 w-4" /> {t("tabs.settings")}
    </Link>
  );
  const header = (
    <header className={cn("mb-6", SIDE_HIDDEN)}>
      <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl bg-bg-subtle text-4xl">
        <AgentGlyph icon={agent.icon} />
      </span>
      <h1 className="font-display text-2xl tracking-tight break-words">{agent.name}</h1>
      {agent.description && <p className="mt-2 max-w-2xl text-sm text-fg-muted">{agent.description}</p>}
    </header>
  );
  const aside = schedules.length > 0 && <Schedules schedules={schedules} />;
  return (
    <AgentChat
      workspaceId={workspaceId}
      agentId={agent.id}
      place={null}
      variant="page"
      focusRun={focusRun}
      header={header}
      aside={aside}
      crumbs={crumbs}
      actions={settings}
    />
  );
}

function AgentGlyph({ icon }: { icon: string | null }) {
  return icon ? <IconGlyph icon={icon} /> : <Bot className="h-[0.9em] w-[0.9em] text-fg-muted" aria-hidden />;
}

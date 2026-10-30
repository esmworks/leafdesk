"use client";

import { Bot, Settings2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { lazyPart } from "@/components/lazy-part";
import { SIDE_COLUMN, SIDE_CONTAINER, SIDE_HIDDEN, SIDE_SHOWN } from "@/lib/side-layout";
import { buttonClass, cn } from "@/components/ui";
import { agentPath } from "@/lib/agent-chat";
import type { AgentScheduleView } from "@/lib/agents";

const AgentChat = lazyPart(
  () => import("@/components/agent-chat/agent-chat").then((m) => m.AgentChat),
  <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />,
);
// Only for an agent with schedules, on a wide page.
const Schedules = lazyPart(() => import("@/components/agent-chat/agent-schedules-box").then((m) => m.AgentSchedulesBox));

type Agent = { id: string; name: string; icon: string | null; description: string };

/**
 * An agent's own page, which the sidebar opens: who it is, then a chat with it. Its settings stay
 * in the dialog. On a wide page who it is moves into the boxes beside the chat, with its schedules
 * and, once the chat loads, its runs and what they changed (the chat puts those there itself).
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
  const tc = useTranslations("page.agentChat.side");
  // Where the chat puts its boxes, below these.
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  // And the lines to its questions, at its start side.
  const [lines, setLines] = useState<HTMLDivElement | null>(null);
  const settings = (
    <Link href={agentPath(workspaceId, agent.id)} className={buttonClass()}>
      <Settings2 className="h-4 w-4" /> {t("tabs.settings")}
    </Link>
  );
  // The strip and the boxes hold to the top of the workspace's scrolling page, which starts below the
  // desktop app's tab strip already (--app-top), and are as tall as it.
  return (
    <div className={cn(SIDE_CONTAINER, "min-h-full")}>
      <div className="flex min-h-full">
        <div className="sticky top-0 hidden h-[calc(100svh-var(--app-top))] w-10 shrink-0 items-center self-start ps-2 md:flex">
          <div ref={setLines} />
        </div>
        <div className="mx-auto flex min-h-full max-w-3xl min-w-0 flex-1 flex-col px-4 pt-14 md:px-6 md:pt-12">
          <header className={cn("mb-4 flex flex-wrap items-start gap-4", SIDE_HIDDEN)}>
            <div className="min-w-0 flex-1 basis-64">
              <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl bg-bg-subtle text-4xl">
                <AgentGlyph icon={agent.icon} />
              </span>
              <h1 className="text-2xl font-semibold tracking-tight break-words">{agent.name}</h1>
              {agent.description && <p className="mt-2 max-w-2xl text-sm text-fg-muted">{agent.description}</p>}
            </div>
            {settings}
          </header>
          <AgentChat workspaceId={workspaceId} agentId={agent.id} place={null} variant="page" focusRun={focusRun} side={side} lines={lines} />
        </div>
        <aside
          aria-label={tc("label", { name: agent.name })}
          className={cn(SIDE_SHOWN, SIDE_COLUMN, "sticky top-0 max-h-[calc(100svh-var(--app-top))] self-start overflow-y-auto pe-4 pt-4 pb-4")}
        >
          <section className="shrink-0 rounded-xl border border-border bg-bg p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-subtle text-2xl">
                <AgentGlyph icon={agent.icon} />
              </span>
              {settings}
            </div>
            <h1 className="text-base font-semibold break-words">{agent.name}</h1>
            {agent.description && (
              <p title={agent.description} className="mt-1 line-clamp-3 text-sm text-fg-muted">
                {agent.description}
              </p>
            )}
          </section>
          {schedules.length > 0 && <Schedules schedules={schedules} />}
          <div ref={setSide} className="contents" />
        </aside>
      </div>
    </div>
  );
}

function AgentGlyph({ icon }: { icon: string | null }) {
  return icon ? <IconGlyph icon={icon} /> : <Bot className="h-[0.9em] w-[0.9em] text-fg-muted" aria-hidden />;
}

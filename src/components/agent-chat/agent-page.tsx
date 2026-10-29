"use client";

import { Bot, Settings2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { IconGlyph } from "@/components/builtin-icon";
import { lazyPart } from "@/components/lazy-part";
import { buttonClass } from "@/components/ui";
import { agentPath } from "@/lib/agent-chat";

const AgentChat = lazyPart(
  () => import("@/components/agent-chat/agent-chat").then((m) => m.AgentChat),
  <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />,
);

/** An agent's own page, which the sidebar opens: who it is, then a chat with it. Its settings stay in the dialog. */
export function AgentPage({
  workspaceId,
  agent,
  focusRun,
}: {
  workspaceId: string;
  agent: { id: string; name: string; icon: string | null; description: string };
  focusRun: string | null;
}) {
  const t = useTranslations("settings.agents");
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 pt-14 md:px-6 md:pt-12">
      <header className="mb-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl bg-bg-subtle text-4xl">
            {agent.icon ? <IconGlyph icon={agent.icon} /> : <Bot className="h-8 w-8 text-fg-muted" aria-hidden />}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight break-words">{agent.name}</h1>
          {agent.description && <p className="mt-2 max-w-2xl text-sm text-fg-muted">{agent.description}</p>}
        </div>
        <Link href={agentPath(workspaceId, agent.id)} className={buttonClass()}>
          <Settings2 className="h-4 w-4" /> {t("tabs.settings")}
        </Link>
      </header>
      <AgentChat workspaceId={workspaceId} agentId={agent.id} place={null} variant="page" focusRun={focusRun} />
    </div>
  );
}

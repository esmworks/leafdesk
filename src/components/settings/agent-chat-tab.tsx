"use client";

import { lazyPart } from "@/components/lazy-part";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/settings/copy-button";
import { agentPath } from "@/lib/agent-chat";
import type { AgentView } from "@/lib/agents";

// The chat comes with the tab, not with the settings.
const AgentChat = lazyPart(() => import("@/components/agent-chat/agent-chat").then((m) => m.AgentChat), <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />);

/**
 * A chat with the agent (lib/agent-chat.ts), for anyone it is shared with: to try it out and give
 * it one-off jobs, with its own access, tools, skills, memory and limits. Its link, pasted in a
 * page, puts a chat with it there.
 */
export function AgentChatTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("page.agentChat.tab");
  // The whole address once in the browser (the server doesn't know the origin it is reached at).
  const [link, setLink] = useState(agentPath(workspaceId, agent.id));
  useEffect(() => setLink(new URL(agentPath(workspaceId, agent.id), window.location.origin).href), [workspaceId, agent.id]);
  return (
    <div className="px-5 py-3">
      {agent.archived ? null : (
        <div className="mb-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-fg-muted">{t("hint")}</p>
          <CopyButton value={link} label={t("copyLink")} />
        </div>
      )}
      <AgentChat workspaceId={workspaceId} agentId={agent.id} place={null} variant="dialog" />
    </div>
  );
}

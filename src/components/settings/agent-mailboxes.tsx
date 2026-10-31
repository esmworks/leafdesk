"use client";

import { Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { setAgentMailboxAction } from "@/app/actions/agents";
import { read } from "@/components/read";
import { useAction } from "@/components/settings/workspace-settings";
import { cn, Switch } from "@/components/ui";
import type { AgentView } from "@/lib/agents";
import type { AgentMailboxView } from "@/server/agents/mail";

/**
 * The person's own mailboxes on an agent's Access tab, each opened to the agent or not
 * (server/agents/mail.ts). Shown to whoever may use the agent and the Mail tab; no one else's.
 */
export function AgentMailboxes({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.mail");
  const [boxes, setBoxes] = useState<AgentMailboxView[] | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    read("agentMailboxes", workspaceId, agent.id)
      .then((res) => live && res.ok && setBoxes(res.data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id]);

  if (!boxes?.length) return null;
  return (
    <section aria-labelledby="agent-mail-title" className={cn("space-y-2 border-t border-border pt-4", pending && "opacity-70")}>
      <h3 id="agent-mail-title" className="text-sm font-medium">
        {t("title")}
      </h3>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {boxes.map((box) => (
          <li key={box.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <Mail className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{box.address}</span>
            <Switch
              checked={box.open}
              label={t("open", { address: box.address })}
              disabled={pending || (agent.archived && !box.open)}
              onChange={(open) => run(() => setAgentMailboxAction(workspaceId, agent.id, box.id, open), setBoxes)}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">{t("note")}</p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

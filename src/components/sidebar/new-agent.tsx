"use client";

import { useTranslations } from "next-intl";
import { AgentDescribeDialog } from "@/components/settings/agent-describe-dialog";
import { AgentForm } from "@/components/settings/agent-dialog";
import { Dialog, DialogHeader } from "@/components/ui";
import type { AgentView } from "@/lib/agents";
import type { AgentCreationInfo } from "@/server/agents/creation";

/**
 * The sidebar's New agent: the same dialogs as Settings > Agents, from scratch or from a description
 * the AI drafts the agent from. Loaded the first time it opens (a lazyPart in sidebar.tsx).
 */
export function NewAgentDialog({
  workspaceId,
  kind,
  info,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  kind: "blank" | "describe";
  info: AgentCreationInfo;
  onClose: () => void;
  /** The agent made; `kind` says where its settings go on (what it may open, or the rest). */
  onCreated: (agent: AgentView, kind: "blank" | "describe") => void;
}) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("common");
  if (kind === "describe" && info.ai === "on") {
    return (
      <AgentDescribeDialog
        workspaceId={workspaceId}
        isOwner={info.isOwner}
        models={info.models}
        webSearch={info.webSearch}
        onClose={onClose}
        onCreated={(agent) => onCreated(agent, "describe")}
      />
    );
  }
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader title={t("form.createTitle")} onClose={onClose} closeLabel={tc("close")} />
      <AgentForm
        workspaceId={workspaceId}
        isOwner={info.isOwner}
        models={info.models}
        webSearch={info.webSearch}
        onDone={onClose}
        onCreated={(agent) => onCreated(agent, "blank")}
      />
    </Dialog>
  );
}

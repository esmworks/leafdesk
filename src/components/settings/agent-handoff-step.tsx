"use client";

import { Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import type { AgentHandoffRecord, AgentRunView } from "@/lib/agents";

/** Opens one of an agent's runs in the agents' settings (its Runs tab, the run opened). */
export type OpenAgentRun = (agentId: string, runId: string) => void;

/** An agent's name that opens its run, when there is one to open. */
function AgentLink({ name, agentId, runId, onOpenRun }: { name: string; agentId: string; runId: string | null; onOpenRun?: OpenAgentRun }) {
  if (!runId || !onOpenRun) return <span className="text-fg">{name}</span>;
  return (
    <button type="button" onClick={() => onOpenRun(agentId, runId)} className="text-fg hover:underline">
      {name}
    </button>
  );
}

/** A step of a run that asked another agent: whom, the task, and how its run went (or why it couldn't be asked). */
export function HandoffStepLine({ step, onOpenRun }: { step: AgentHandoffRecord; onOpenRun?: OpenAgentRun }) {
  const t = useTranslations("settings.agents.runs.handoff");
  const bad = step.outcome !== "done" && step.outcome !== "waiting";
  return (
    <>
      <Users className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", bad && "text-danger")} aria-hidden />
      <span className="min-w-0 break-words">
        {t.rich(step.outcome, {
          agent: () => <AgentLink name={step.agentName} agentId={step.agentId} runId={step.runId} onOpenRun={onOpenRun} />,
          task: step.task,
        })}
      </span>
    </>
  );
}

/** What a run another agent asked for shows as its source: that agent, opening the run that asked. */
export function AskedByLine({ handoff, onOpenRun }: { handoff: NonNullable<AgentRunView["handoff"]>; onOpenRun?: OpenAgentRun }) {
  const t = useTranslations("settings.agents.runs");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
      <Users aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <span className="truncate">
        {t.rich("askedBy", {
          agent: () => (
            <AgentLink name={handoff.fromName || t("removedAgent")} agentId={handoff.fromAgentId} runId={handoff.parentRunId} onOpenRun={onOpenRun} />
          ),
        })}
      </span>
    </span>
  );
}

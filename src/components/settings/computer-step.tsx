"use client";

import { Monitor } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import { COMPUTER_TOOL_NAMES, type AgentToolRecord } from "@/lib/agents";

const OPS = { [COMPUTER_TOOL_NAMES.list]: "list", [COMPUTER_TOOL_NAMES.read]: "read", [COMPUTER_TOOL_NAMES.write]: "write", [COMPUTER_TOOL_NAMES.trash]: "trash" } as const;

/**
 * A run's call on files of its person's computer (server/agents/computer.ts): what it did and
 * where, and why it wasn't done when it wasn't. Its input is the place (`path`), never the content.
 */
export function ComputerStepLine({ step }: { step: AgentToolRecord }) {
  const t = useTranslations("settings.agents.runs.computer");
  const op = OPS[step.tool as keyof typeof OPS] ?? "read";
  const done = step.outcome === "done";
  let path = step.input;
  try {
    const args = JSON.parse(step.input) as Record<string, unknown>;
    if (typeof args.path === "string") path = args.path;
  } catch {}
  const why = step.outcome === "declined" || step.outcome === "expired" || step.outcome === "afterMail" || step.outcome === "limited" ? step.outcome : "failed";
  return (
    <>
      <Monitor className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", !done && "text-danger")} />
      <span className="min-w-0 break-words">
        {t(op)}
        {!done && <span className="text-fg-faint"> · {t(why)}</span>}
        <code className="mt-0.5 block truncate text-xs text-fg-faint" title={path}>
          {path}
        </code>
      </span>
    </>
  );
}

"use client";

import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { agentHelperChoicesAction } from "@/app/actions/agents";
import { cn } from "@/components/ui";
import { MAX_AGENT_HELPERS, MAX_HANDOFFS_PER_RUN } from "@/lib/agents";

type HelperChoice = { id: string; name: string; icon: string | null; enabled: boolean };

/**
 * An agent's "Agents it can ask", in its settings form: the workspace's other agents, ticked or
 * not. `value` is null until the agent's list has loaded (`agentId` null: a new agent, none yet);
 * the form saves it with the rest.
 */
export function AgentHelpersField({
  workspaceId,
  agentId,
  value,
  disabled,
  onChange,
}: {
  workspaceId: string;
  agentId: string | null;
  value: string[] | null;
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations("settings.agents.form");
  const tc = useTranslations("common");
  const [agents, setAgents] = useState<HelperChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    agentHelperChoicesAction(workspaceId, agentId)
      .then((res) => {
        if (!live) return;
        if (!res.ok) return setError(res.error);
        setAgents(res.data.agents);
        onChange(res.data.selected);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
    // Loaded once per agent; `onChange` only reports what it has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentId, tc]);

  const chosen = new Set(value ?? []);
  const full = chosen.size >= MAX_AGENT_HELPERS;
  const toggle = (id: string, on: boolean) => onChange(on ? [...(value ?? []), id] : (value ?? []).filter((x) => x !== id));

  return (
    <div className="border-t border-border pt-3">
      <span className="mb-1 block text-sm" id="agent-helpers-label">
        {t("helpers")}
      </span>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : !agents || value === null ? (
        <p className="text-xs text-fg-muted">{tc("loading")}</p>
      ) : agents.length === 0 ? (
        <p className="text-xs text-fg-muted">{t("helpersEmpty")}</p>
      ) : (
        <ul aria-labelledby="agent-helpers-label" className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {agents.map((a) => {
            const id = `agent-helper-${a.id}`;
            const on = chosen.has(a.id);
            return (
              <li key={a.id} className="flex items-center gap-2.5 px-3 py-1.5">
                <input
                  id={id}
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  checked={on}
                  disabled={disabled || (full && !on)}
                  onChange={(e) => toggle(a.id, e.target.checked)}
                />
                <label htmlFor={id} className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm", disabled && "opacity-60")}>
                  {a.icon ? <span className="shrink-0 leading-none">{a.icon}</span> : <Bot className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />}
                  <span className="truncate">{a.name}</span>
                  {!a.enabled && <span className="shrink-0 text-xs text-fg-muted">{t("helperPaused")}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <span className="mt-1 block text-xs text-fg-muted">{t("helpersHelp", { max: MAX_HANDOFFS_PER_RUN })}</span>
    </div>
  );
}

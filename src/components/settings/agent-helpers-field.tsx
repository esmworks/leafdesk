"use client";

import { IconGlyph } from "@/components/builtin-icon";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { agentHelperChoicesAction } from "@/app/actions/agents";
import { cn, selectClass, Switch } from "@/components/ui";
import { MAX_AGENT_HELPERS, MAX_HANDOFFS_PER_RUN } from "@/lib/agents";
import { AGENT_HELPERS_MODES, type AgentHelpersMode } from "@/lib/agent-team";

type HelperChoice = { id: string; name: string; icon: string | null; enabled: boolean };

/** An agent's place among the others, as its settings form holds it and saves it (lib/agent-team.ts). */
export type AgentTeamValue = { mode: AgentHelpersMode; ids: string[]; reportsTo: string | null; viaManagerOnly: boolean };

const AgentName = ({ agent }: { agent: HelperChoice }) => (
  <>
    {agent.icon ? <IconGlyph icon={agent.icon} className="shrink-0" /> : <Bot className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />}
    <span className="truncate">{agent.name}</span>
  </>
);

/**
 * An agent's "Agents it can ask" (none, all, or those ticked) and "Reports to" (its manager, and
 * whether it works only through it), in its settings form, with the agents that report to it. `value`
 * is null until the agent's setup has loaded (`agentId` null: a new agent); the form saves it with
 * the rest.
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
  value: AgentTeamValue | null;
  disabled?: boolean;
  onChange: (value: AgentTeamValue) => void;
}) {
  const t = useTranslations("settings.agents.form");
  const tc = useTranslations("common");
  const [choices, setChoices] = useState<{ agents: HelperChoice[]; managers: HelperChoice[]; team: HelperChoice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    agentHelperChoicesAction(workspaceId, agentId)
      .then((res) => {
        if (!live) return;
        if (!res.ok) return setError(res.error);
        const { agents, managers, team, selected, mode, reportsTo, viaManagerOnly } = res.data;
        setChoices({ agents, managers, team });
        onChange({ mode, ids: selected, reportsTo, viaManagerOnly });
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
    // Loaded once per agent; `onChange` only reports what it has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentId, tc]);

  if (error) {
    return (
      <p role="alert" className="border-t border-border pt-3 text-xs text-danger">
        {error}
      </p>
    );
  }
  if (!choices || !value) return <p className="border-t border-border pt-3 text-xs text-fg-muted">{tc("loading")}</p>;

  const chosen = new Set(value.ids);
  const full = chosen.size >= MAX_AGENT_HELPERS;
  const set = (patch: Partial<AgentTeamValue>) => onChange({ ...value, ...patch });
  const toggle = (id: string, on: boolean) => set({ ids: on ? [...value.ids, id] : value.ids.filter((x) => x !== id) });
  const { agents, managers, team } = choices;

  return (
    <>
      <div className="border-t border-border pt-3">
        <label htmlFor="agent-helpers-mode" className="mb-1 block text-sm">
          {t("helpers")}
        </label>
        <select
          id="agent-helpers-mode"
          value={value.mode}
          disabled={disabled}
          onChange={(e) => set({ mode: e.target.value as AgentHelpersMode })}
          className={cn(selectClass, "w-full sm:w-auto")}
        >
          {AGENT_HELPERS_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`helpersModes.${mode}`)}
            </option>
          ))}
        </select>
        {value.mode === "chosen" &&
          (agents.length === 0 ? (
            <p className="mt-2 text-xs text-fg-muted">{t("helpersEmpty")}</p>
          ) : (
            <ul aria-label={t("helpers")} className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
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
                      <AgentName agent={a} />
                      {!a.enabled && <span className="shrink-0 text-xs text-fg-muted">{t("helperPaused")}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          ))}
        <span className="mt-1 block text-xs text-fg-muted">
          {value.mode === "none" ? t("helpersNoneHelp") : t(value.mode === "all" ? "helpersAllHelp" : "helpersHelp", { max: MAX_HANDOFFS_PER_RUN })}
        </span>
      </div>
      <div className="border-t border-border pt-3">
        <label htmlFor="agent-reports-to" className="mb-1 block text-sm">
          {t("reportsTo")}
        </label>
        <select
          id="agent-reports-to"
          value={value.reportsTo ?? ""}
          disabled={disabled}
          onChange={(e) => set({ reportsTo: e.target.value || null, ...(e.target.value ? {} : { viaManagerOnly: false }) })}
          className={cn(selectClass, "w-full sm:w-auto")}
        >
          <option value="">{t("reportsToNone")}</option>
          {managers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-fg-muted">{t("reportsToHelp")}</span>
        {value.reportsTo && (
          <div className="mt-3 flex items-center justify-between gap-3 text-sm">
            <div>
              <div>{t("viaManagerOnly")}</div>
              <div className="text-xs text-fg-muted">{t("viaManagerOnlyHelp")}</div>
            </div>
            <Switch checked={value.viaManagerOnly} label={t("viaManagerOnly")} disabled={disabled} onChange={(on) => set({ viaManagerOnly: on })} />
          </div>
        )}
        {team.length > 0 && (
          <div className="mt-3">
            <span className="mb-1 block text-sm">{t("team")}</span>
            <ul aria-label={t("team")} className="divide-y divide-border rounded-md border border-border">
              {team.map((a) => (
                <li key={a.id} className="flex items-center gap-1.5 px-3 py-1.5 text-sm">
                  <AgentName agent={a} />
                  {!a.enabled && <span className="shrink-0 text-xs text-fg-muted">{t("helperPaused")}</span>}
                </li>
              ))}
            </ul>
            <span className="mt-1 block text-xs text-fg-muted">{t("teamHelp")}</span>
          </div>
        )}
      </div>
    </>
  );
}

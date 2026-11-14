"use client";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setAgentChainAction } from "@/app/actions/agents";
import { freshRepeatForm, RepeatRuleFields, repeatFormOf, useRepeatRule, type RepeatForm } from "@/components/repeat-rule-fields";
import { useShareablePages } from "@/components/settings/agent-page-picker";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, IconButton, Input, pageLabel, selectClass, Switch, textareaClass } from "@/components/ui";
import { MAX_CHAIN_NAME, MAX_CHAIN_STEPS, MIN_CHAIN_STEPS, type AgentChainView } from "@/lib/agent-chains";
import { MAX_SCHEDULE_TASK } from "@/lib/agents";
import type { SidebarAgent } from "@/server/agents/manage";

type StepDraft = { key: string; agentId: string; task: string; databaseId: string };

const newStep = (agentId = ""): StepDraft => ({ key: crypto.randomUUID(), agentId, task: "", databaseId: "" });

/**
 * Making or changing a chain of agents (server/agents/chains.ts): its name, its steps in order (an
 * agent, its task and the database it may change), and whether it also runs on a schedule. Loaded
 * the first time it opens (a lazyPart in agent-chains.tsx).
 */
export function AgentChainDialog({
  workspaceId,
  agents,
  chain,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  /** The agents the person may edit: the ones a step may run. */
  agents: SidebarAgent[];
  /** The chain to change; null for a new one. */
  chain: AgentChainView | null;
  onClose: () => void;
  onSaved: (chains: AgentChainView[]) => void;
}) {
  const t = useTranslations("sidebar.agentChains");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [name, setName] = useState(chain?.name ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    chain ? chain.steps.map((s) => ({ key: crypto.randomUUID(), agentId: s.agentId, task: s.task, databaseId: s.databaseId ?? "" })) : [newStep(agents[0]?.id), newStep()],
  );
  const [repeats, setRepeats] = useState(chain?.repeats ?? false);
  const [repeat, setRepeat] = useState<RepeatForm>(() => (chain ? repeatFormOf(chain.rule, chain.timeZone) : freshRepeatForm({ frequency: "daily" })));
  const { rule, valid, next } = useRepeatRule(repeat);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pages = useShareablePages(workspaceId, { anyAccess: true });
  const databases = (pages ?? []).filter((p) => p.kind === "database");
  const editable = new Set(agents.map((a) => a.id));

  const change = (key: string, patch: Partial<StepDraft>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (index: number, by: -1 | 1) =>
    setSteps((all) => {
      const next = [...all];
      const [moved] = next.splice(index, 1);
      next.splice(index + by, 0, moved);
      return next;
    });

  const ready = name.trim() !== "" && steps.length >= MIN_CHAIN_STEPS && steps.every((s) => s.agentId && s.task.trim()) && rule !== null && valid;

  function save() {
    if (!ready || !rule) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setAgentChainAction(workspaceId, chain?.id ?? null, {
          name: name.trim(),
          steps: steps.map((s) => ({ agentId: s.agentId, task: s.task.trim(), databaseId: s.databaseId || null })),
          repeats,
          rule,
          timeZone: repeat.timeZone,
        });
        if (result.ok) onSaved(result.data);
        else setError(result.error);
      } catch {
        setError(tc("genericError"));
      }
    });
  }

  const label = "block text-xs font-medium text-fg-muted";
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader title={chain ? t("titleEdit") : t("titleNew")} description={t("intro")} onClose={onClose} closeLabel={tc("close")} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <DialogBody className={cn("space-y-4", pending && "opacity-70")}>
          <div className="space-y-1">
            <label htmlFor="agent-chain-name" className={label}>
              {t("name")}
            </label>
            <Input id="agent-chain-name" autoFocus value={name} maxLength={MAX_CHAIN_NAME} placeholder={t("namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </div>
          <ol className="space-y-3">
            {steps.map((step, i) => (
              <li key={step.key} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center gap-1">
                  <span className="flex-1 text-sm font-medium">{t("step", { n: i + 1 })}</span>
                  <IconButton label={t("moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label={t("moveDown")} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label={t("removeStep")} disabled={steps.length <= MIN_CHAIN_STEPS} onClick={() => setSteps((all) => all.filter((s) => s.key !== step.key))}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor={`agent-chain-agent-${step.key}`} className={label}>
                      {t("agent")}
                    </label>
                    <select id={`agent-chain-agent-${step.key}`} className={cn(selectClass, "w-full")} value={step.agentId} onChange={(e) => change(step.key, { agentId: e.target.value })}>
                      <option value="" disabled>
                        {t("chooseAgent")}
                      </option>
                      {/* One kept from before that the person can no longer edit (saving it then fails, saying so). */}
                      {step.agentId && !editable.has(step.agentId) && <option value={step.agentId}>{chain?.steps.find((s) => s.agentId === step.agentId)?.agentName || t("removedAgent")}</option>}
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`agent-chain-database-${step.key}`} className={label}>
                      {t("database")}
                    </label>
                    <select
                      id={`agent-chain-database-${step.key}`}
                      className={cn(selectClass, "w-full")}
                      value={step.databaseId}
                      onChange={(e) => change(step.key, { databaseId: e.target.value })}
                    >
                      <option value="">{t("noDatabase")}</option>
                      {step.databaseId && !databases.some((d) => d.id === step.databaseId) && (
                        <option value={step.databaseId}>{pageLabel(chain?.steps.find((s) => s.databaseId === step.databaseId)?.databaseTitle ?? "", tc("untitled"))}</option>
                      )}
                      {databases.map((d) => (
                        <option key={d.id} value={d.id}>
                          {pageLabel(d.title, tc("untitled"))}
                          {d.place ? ` · ${d.place}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor={`agent-chain-task-${step.key}`} className={label}>
                    {t("task")}
                  </label>
                  <textarea
                    id={`agent-chain-task-${step.key}`}
                    rows={3}
                    maxLength={MAX_SCHEDULE_TASK}
                    className={textareaClass}
                    placeholder={i === 0 ? t("firstTaskPlaceholder") : t("taskPlaceholder")}
                    value={step.task}
                    onChange={(e) => change(step.key, { task: e.target.value })}
                  />
                </div>
              </li>
            ))}
          </ol>
          {steps.length < MAX_CHAIN_STEPS && (
            <Button type="button" onClick={() => setSteps((all) => [...all, newStep()])}>
              <Plus className="h-4 w-4" />
              {t("addStep")}
            </Button>
          )}
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t("repeats")}</span>
              <Switch checked={repeats} onChange={setRepeats} label={t("repeats")} />
            </div>
            {repeats ? (
              <>
                <RepeatRuleFields form={repeat} onChange={(patch) => setRepeat((r) => ({ ...r, ...patch }))} idPrefix="agent-chain" />
                {next && <p className="text-sm text-fg-muted">{t("next", { date: format.dateTime(next, { dateStyle: "full", timeStyle: "short", timeZone: repeat.timeZone }) })}</p>}
              </>
            ) : (
              <p className="text-xs text-fg-faint">{t("manualHint")}</p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || pending}>
            {chain ? tc("save") : t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

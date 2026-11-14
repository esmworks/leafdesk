"use client";

import { AtSign, CalendarClock, ChevronRight, Hash, Mail, MessageSquare, MousePointerClick, Plug, Send, Workflow, Zap, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { read } from "@/components/read";
import { cn } from "@/components/ui";
import type { AgentView } from "@/lib/agents";
import type { TriggerKind, TriggerView } from "@/lib/triggers";
import type { AgentTab } from "./agent-dialog";
import { useRuleSummary } from "./rule-summary";

const ICONS: Record<TriggerKind, LucideIcon> = {
  chat: MessageSquare,
  mention: AtSign,
  channel: Hash,
  request: Send,
  schedule: CalendarClock,
  chain: Workflow,
  automation: Zap,
  button: MousePointerClick,
  mail: Mail,
  connection: Plug,
};

/**
 * Everything that can start the agent's runs, in one list (server/triggers.ts listTriggers): how
 * people reach it, its schedules, the automations and buttons that run it, mail opened to it and
 * connections' events, each with the conversation its runs go to. Each opens where it is changed.
 */
export function AgentTriggersTab({ workspaceId, agent, onTab }: { workspaceId: string; agent: AgentView; onTab: (tab: AgentTab) => void }) {
  const t = useTranslations("settings.agents.triggers");
  const summary = useRuleSummary();
  const [triggers, setTriggers] = useState<TriggerView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    read("agentTriggers", workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setTriggers(res.data);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id]);

  const row = (trigger: TriggerView) => {
    switch (trigger.kind) {
      case "chat":
      case "mention":
      case "channel":
      case "request":
        return { title: t(trigger.kind), detail: t(`${trigger.kind}Hint`), on: trigger.available, open: trigger.kind === "chat" ? () => onTab("chat") : null };
      case "schedule":
        return { title: trigger.taskHidden || !trigger.task ? t("schedule") : trigger.task, detail: summary(trigger.rule, trigger.timeZone), on: trigger.enabled, open: () => onTab("schedules") };
      case "chain":
        return { title: trigger.name, detail: t("chainSteps", { steps: trigger.steps.join(", "), total: trigger.total }), on: !trigger.repeats || trigger.enabled };
      case "automation":
      case "button":
        return {
          title: trigger.name,
          detail: t(trigger.kind === "button" ? "buttonIn" : "automationIn", { database: trigger.databaseTitle || t("untitled") }),
          on: trigger.enabled,
          href: `/w/${workspaceId}/p/${trigger.databaseId}`,
        };
      case "mail":
        return { title: t("mail", { address: trigger.address }), detail: trigger.task, on: trigger.enabled, open: () => onTab("access") };
      case "connection":
        return { title: t("connection", { connection: trigger.connectionName }), detail: trigger.eventType ?? trigger.prompt, on: trigger.enabled, open: () => onTab("connections") };
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">{t("description")}</p>
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t("loadFailed")}
        </p>
      ) : !triggers ? (
        <div aria-busy="true" className="h-24 animate-pulse rounded-md bg-bg-subtle" />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {triggers.map((trigger, i) => {
            const { title, detail, on, open, href } = { open: null, href: null, ...row(trigger) };
            const Icon = ICONS[trigger.kind];
            const body = (
              <>
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", on ? "text-fg-muted" : "text-fg-faint")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", !on && "text-fg-muted")}>{title}</span>
                  {detail && <span className="block truncate text-xs text-fg-muted">{detail}</span>}
                  <span className="block text-xs text-fg-muted">{t(`conversation.${trigger.conversation}`)}</span>
                </span>
                {!on && <span className="shrink-0 text-xs text-fg-muted">{trigger.kind === "chat" || trigger.kind === "mention" || trigger.kind === "channel" || trigger.kind === "request" ? t("unavailable") : t("off")}</span>}
                {(open || href) && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted rtl:rotate-180" aria-hidden />}
              </>
            );
            const itemClass = "flex w-full items-start gap-3 px-3 py-2.5 text-start text-sm";
            return (
              <li key={`${trigger.kind}-${"id" in trigger ? trigger.id : "mailboxId" in trigger ? trigger.mailboxId : i}`}>
                {href ? (
                  <Link href={href} className={cn(itemClass, "hover:bg-bg-hover")}>
                    {body}
                  </Link>
                ) : open ? (
                  <button type="button" onClick={open} className={cn(itemClass, "hover:bg-bg-hover")}>
                    {body}
                  </button>
                ) : (
                  <div className={itemClass}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

"use client";

import { CalendarClock } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRuleSummary } from "@/components/settings/rule-summary";
import { SideBox, SideItem } from "@/components/side-box";
import type { AgentScheduleView } from "@/lib/agents";

/** When the agent runs on its own: each schedule's rule and its next run, or that it is paused. */
export function AgentSchedulesBox({ schedules }: { schedules: AgentScheduleView[] }) {
  const t = useTranslations("settings.agents");
  const tc = useTranslations("page.agentChat.side");
  const format = useFormatter();
  const summary = useRuleSummary();
  return (
    <SideBox title={t("tabs.schedules")} count={schedules.length}>
      {schedules.map((s) => (
        <SideItem key={s.id} icon={<CalendarClock className="h-3.5 w-3.5" />}>
          <span className="block break-words">{summary(s.rule, s.timeZone)}</span>
          <span className="block text-xs text-fg-muted">
            {s.enabled && s.nextRunAt
              ? t("schedules.next", { date: format.dateTime(new Date(s.nextRunAt), { dateStyle: "medium", timeStyle: "short", timeZone: s.timeZone }) })
              : tc("paused")}
          </span>
        </SideItem>
      ))}
    </SideBox>
  );
}

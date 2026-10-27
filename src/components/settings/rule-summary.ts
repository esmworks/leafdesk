import { useFormatter, useTranslations } from "next-intl";
import { WEEKDAYS_FROM_MONDAY, type RepeatRule } from "@/lib/schedule";
import { timeZoneLabel } from "@/lib/time-zone";

// Its own module: Settings, the account page and the dashboard email dialog use it without the
// agent schedules tab.

/** "Every 2 weeks on Mon, Thu · 08:00 (Europe/Istanbul)", in the viewer's words. */
export function useRuleSummary() {
  const t = useTranslations("settings.agents.schedules");
  const tr = useTranslations("database.page.templates.repeatDialog");
  const format = useFormatter();
  return (rule: RepeatRule, timeZone: string) => {
    const how = rule.interval === 1 ? tr(`frequencies.${rule.frequency}`) : t("every", { count: rule.interval, unit: tr(`units.${rule.frequency}`, { count: rule.interval }) });
    const days =
      rule.frequency === "weekly"
        ? WEEKDAYS_FROM_MONDAY.filter((d) => rule.weekdays.includes(d))
            // 2026-10-04 was a Sunday: day 0 of that week.
            .map((d) => format.dateTime(new Date(Date.UTC(2026, 9, 4 + d)), { weekday: "short", timeZone: "UTC" }))
            .join(", ")
        : "";
    const zone = timeZoneLabel(timeZone);
    return days ? t("summaryOn", { how, days, time: rule.time, zone }) : t("summary", { how, time: rule.time, zone });
  };
}

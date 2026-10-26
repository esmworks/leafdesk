"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { leaveDashboardEmailAction, removeDashboardEmailAction } from "@/app/actions/dashboard-emails";
import { Button } from "@/components/ui";
import type { MyDashboardEmail } from "@/server/dashboard-emails";
import { useRuleSummary } from "./rule-summary";
import { SettingsRow } from "./section";

/**
 * Settings > Preferences: the dashboards emailed to the user and the emails they set up, in every
 * workspace (server/dashboard-emails myDashboardEmails), each with a way to leave or stop it.
 */
export function DashboardEmailSettings({ emails: initial, viewerId }: { emails: MyDashboardEmail[]; viewerId: string }) {
  const t = useTranslations("settings.notifications");
  const te = useTranslations("page.dashboard.emails");
  const tc = useTranslations("common");
  const summary = useRuleSummary();
  const [emails, setEmails] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (email: MyDashboardEmail, how: "leave" | "stop") =>
    startTransition(async () => {
      setError(null);
      const result = how === "leave" ? await leaveDashboardEmailAction(email.id) : await removeDashboardEmailAction(email.id);
      if (!result.ok) return setError(result.error);
      setEmails((list) =>
        how === "stop" || email.setBy?.id !== viewerId ? list.filter((e) => e.id !== email.id) : list.map((e) => (e.id === email.id ? { ...e, receives: false } : e)),
      );
    });

  if (!emails.length) return <SettingsRow title={t("dashboardEmailsNone")} description={t("dashboardEmailsNoneDescription")} />;
  return (
    <>
      {error && <p className="px-5 pt-4 text-sm text-danger">{error}</p>}
      {emails.map((e) => {
        const names = e.recipients.map((r) => (r.id === viewerId ? te("you") : r.name)).join(", ");
        const href = `/w/${e.workspaceId}/p/${e.pageId}${"view" in e.target ? `?view=${e.target.view}` : ""}`;
        return (
          <SettingsRow
            key={e.id}
            title={
              <Link href={href} className="truncate hover:underline">
                {e.title || tc("untitled")}
              </Link>
            }
            description={
              <>
                {te("summary", { schedule: summary(e.rule, e.timeZone), period: te(`periods.${e.period}`) })}
                <br />
                {te("to", { names })}
                {!e.enabled && e.lastError && (
                  <>
                    <br />
                    <span className="text-danger">{te(`paused.${e.lastError}`)}</span>
                  </>
                )}
              </>
            }
            control={
              <div className="flex gap-1">
                {e.receives && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(e, "leave")}>
                    {te("leave")}
                  </Button>
                )}
                {e.canChange && (
                  <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => act(e, "stop")}>
                    {te("stop")}
                  </Button>
                )}
              </div>
            }
          />
        );
      })}
    </>
  );
}

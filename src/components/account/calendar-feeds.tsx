import { getFormatter, getTranslations } from "next-intl/server";
import { CalendarCheck } from "lucide-react";
import { PageIcon } from "@/components/ui";
import { SettingsGroup } from "@/components/settings/section";
import { pageLabel } from "@/lib/labels";
import { listCalendarFeeds } from "@/server/calendar-feeds";
import { CalendarFeedOffButton } from "./calendar-feed-off-button";

/**
 * Account > Email and calendar: every calendar address the person made (server/calendar-feeds.ts),
 * from a calendar view or from the rows assigned to them, each with a way to turn it off.
 */
export async function CalendarFeeds({ userId }: { userId: string }) {
  const [feeds, t, tc, format] = await Promise.all([listCalendarFeeds(userId), getTranslations("account.mail"), getTranslations("common"), getFormatter()]);
  const now = new Date();
  return (
    <SettingsGroup title={t("calendarsHeading")} description={t("calendarsDescription")}>
      {feeds.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("calendarsEmpty")}</p>
      ) : (
        feeds.map((feed) => {
          const name =
            feed.kind === "assigned"
              ? t("assignedFeed")
              : feed.title === null
                ? t("feedNoAccess")
                : `${pageLabel(feed.title, tc("untitled"))}${feed.view ? ` · ${feed.view}` : ""}`;
          return (
            <div key={feed.id} className="flex items-center gap-3 px-5 py-4">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-fg-muted">
                {feed.kind === "view" && feed.title !== null ? <PageIcon icon={feed.icon} kind="database" /> : <CalendarCheck className="h-4 w-4" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{name}</div>
                <p className="mt-0.5 text-sm text-fg-muted">
                  {feed.workspace && <>{feed.workspace} · </>}
                  {t("made", { date: format.dateTime(feed.createdAt, { dateStyle: "medium" }) })}
                  {" · "}
                  {feed.lastUsedAt ? t("lastRead", { time: format.relativeTime(feed.lastUsedAt, now) }) : t("neverRead")}
                </p>
              </div>
              <CalendarFeedOffButton feedId={feed.id} />
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}

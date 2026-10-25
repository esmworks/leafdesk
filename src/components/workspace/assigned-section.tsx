import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AssignedCalendarFeedButton } from "@/components/database/calendar-feed";
import { AssignedList } from "@/components/workspace/assigned-list";
import type { AssignedRows } from "@/server/assigned";

/**
 * The home page's list of open database rows assigned to the viewer and unticked to-dos in pages
 * that mention them, by when they are due, with
 * the calendar feed of them and a link to My tasks in its header. Says so when nothing is assigned.
 */
export async function AssignedSection({
  workspaceId,
  assigned,
  today,
}: {
  workspaceId: string;
  assigned: AssignedRows;
  today: string;
}) {
  const t = await getTranslations("home");
  const shown = assigned.groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <section className="space-y-3" aria-labelledby="assigned-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="assigned-heading" className="shrink-0 text-sm font-semibold">
          {t("assigned")}
        </h2>
        <div className="flex min-w-0 items-center gap-1">
          <AssignedCalendarFeedButton workspaceId={workspaceId} />
          {assigned.groups.length > 0 && (
            <Link href={`/w/${workspaceId}/tasks`} className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg">
              {t("assignedAll")}
            </Link>
          )}
        </div>
      </div>
      {!assigned.groups.length && (
        // A standing section, empty for most people most days: a line, not a box that calls for action.
        <p className="text-sm text-fg-muted">{t("assignedEmpty")}</p>
      )}
      <AssignedList workspaceId={workspaceId} grouping="due" groups={assigned.groups} today={today} />
      {assigned.total > shown && (
        <p className="text-xs text-fg-muted">
          {t("assignedMore", { shown, total: assigned.total })}{" "}
          <Link href={`/w/${workspaceId}/tasks`} className="underline hover:text-fg">
            {t("assignedAll")}
          </Link>
        </p>
      )}
    </section>
  );
}

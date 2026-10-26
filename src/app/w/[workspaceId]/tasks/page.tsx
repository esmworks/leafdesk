import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";
import { AssignedCalendarFeedButton } from "@/components/database/calendar-feed";
import { AssignedList, type AssignedListGroup } from "@/components/workspace/assigned-list";
import { groupByDatabase, isAssignedGrouping } from "@/lib/assigned";
import { dayString, localDay } from "@/lib/time-zone";
import { assignedRows, MY_TASKS_LIMIT } from "@/server/assigned";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home.myTasks");
  return { title: t("title") };
}

/**
 * My tasks: the open database rows assigned to the person across the workspace (server/assigned.ts)
 * and the unticked to-dos in pages that mention them (server/page-tasks.ts), by due date or by
 * database or page (`?by=database`), the first MY_TASKS_LIMIT of them.
 */
export default async function MyTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ by?: string }>;
}) {
  const [{ workspaceId }, { by }] = await Promise.all([params, searchParams]);
  const { user } = await requireWorkspaceSession(workspaceId);
  const grouping = isAssignedGrouping(by) ? by : "due";
  const timeZone = await getTimeZone();
  const today = dayString(localDay(Date.now(), timeZone));
  const [assigned, t, locale] = await Promise.all([
    assignedRows(user.id, workspaceId, today, timeZone, MY_TASKS_LIMIT),
    getTranslations("home"),
    getLocale(),
  ]);
  const rows = assigned.groups.flatMap((g) => g.rows);
  const groups: AssignedListGroup[] =
    grouping === "due"
      ? assigned.groups
      : groupByDatabase(rows, new Intl.Collator(locale)).map((g) => ({ key: g.databaseId, databaseTitle: g.databaseTitle, rows: g.rows }));
  const tab = (key: "due" | "database", label: string) => (
    <Link
      href={key === "due" ? `/w/${workspaceId}/tasks` : `/w/${workspaceId}/tasks?by=database`}
      replace
      aria-current={grouping === key ? "page" : undefined}
      className={
        grouping === key
          ? "flex h-7 items-center rounded-md bg-bg px-2.5 text-sm font-medium text-fg shadow-sm"
          : "flex h-7 items-center rounded-md px-2.5 text-sm text-fg-muted transition-colors hover:text-fg"
      }
    >
      {label}
    </Link>
  );

  return (
    <div className="page-gutter pt-[4.25rem] pb-12">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-bold leading-tight md:text-3xl">{t("myTasks.title")}</h1>
        <p className="text-sm text-fg-muted">{t("myTasks.description")}</p>
      </header>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t("myTasks.grouping")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          {tab("due", t("myTasks.byDue"))}
          {tab("database", t("myTasks.byDatabase"))}
        </nav>
        <AssignedCalendarFeedButton workspaceId={workspaceId} />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("assignedEmpty")}</p>
      ) : (
        <AssignedList workspaceId={workspaceId} grouping={grouping} groups={groups} today={today} />
      )}
      {assigned.total > rows.length && (
        <p className="mt-4 text-xs text-fg-muted">{t("myTasks.shown", { shown: rows.length, total: assigned.total })}</p>
      )}
    </div>
  );
}

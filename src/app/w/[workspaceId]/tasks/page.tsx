import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";
import { AssignedCalendarFeedButton } from "@/components/database/calendar-feed";
import { AssignedList, type AssignedListGroup } from "@/components/workspace/assigned-list";
import { groupByDatabase, isAssignedGrouping, isTaskView, SHARED_PLACE } from "@/lib/assigned";
import { pageLabel } from "@/lib/labels";
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
 * database or page (`?by=database`), the first MY_TASKS_LIMIT of them. The sidebar's tasks tab
 * narrows it to a view (`?view=`, lib/assigned.ts TaskView) or to one database or page (`?in=`).
 */
export default async function MyTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ by?: string; view?: string; in?: string }>;
}) {
  const [{ workspaceId }, { by, view: viewParam, in: inParam }] = await Promise.all([params, searchParams]);
  const { user } = await requireWorkspaceSession(workspaceId);
  const grouping = isAssignedGrouping(by) ? by : "due";
  const view = isTaskView(viewParam) ? viewParam : "all";
  const place = typeof inParam === "string" && inParam.length > 0 && inParam.length <= 64 ? inParam : undefined;
  const timeZone = await getTimeZone();
  const today = dayString(localDay(Date.now(), timeZone));
  const [assigned, t, locale, tc] = await Promise.all([
    assignedRows(user.id, workspaceId, today, timeZone, MY_TASKS_LIMIT, { view, place }),
    getTranslations("home"),
    getLocale(),
    getTranslations("common"),
  ]);
  const rows = assigned.groups.flatMap((g) => g.rows);
  const groups: AssignedListGroup[] =
    grouping === "due"
      ? assigned.groups
      : groupByDatabase(rows, new Intl.Collator(locale)).map((g) => ({ key: g.databaseId, databaseTitle: g.databaseTitle, rows: g.rows }));
  // The view or place keeps as the grouping changes.
  const hrefFor = (key: "due" | "database") => {
    const query = new URLSearchParams({ ...(key === "database" ? { by: key } : {}), ...(view !== "all" ? { view } : {}), ...(place ? { in: place } : {}) });
    return `/w/${workspaceId}/tasks${query.size ? `?${query}` : ""}`;
  };
  const first = rows[0];
  const placeTitle =
    !place || !first ? null
    : place === SHARED_PLACE ? t("myTasks.sharedRows")
    : pageLabel(first.type === "pageTask" ? first.pageTitle : (first.databaseTitle ?? ""), tc("untitled"));
  const title = view !== "all" ? t(`myTasks.views.${view}`) : (placeTitle ?? t("myTasks.title"));
  const filtered = view !== "all" || !!place;
  const tab = (key: "due" | "database", label: string) => (
    <Link
      href={hrefFor(key)}
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
        <h1 className="font-display text-2xl leading-tight tracking-tight md:text-3xl">{title}</h1>
        <p className="text-sm text-fg-muted">{filtered ? t("myTasks.filtered") : t("myTasks.description")}</p>
      </header>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t("myTasks.grouping")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          {tab("due", t("myTasks.byDue"))}
          {tab("database", t("myTasks.byDatabase"))}
        </nav>
        <AssignedCalendarFeedButton workspaceId={workspaceId} />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{filtered ? t("myTasks.filteredEmpty") : t("assignedEmpty")}</p>
      ) : (
        <AssignedList workspaceId={workspaceId} grouping={grouping} groups={groups} today={today} />
      )}
      {assigned.total > rows.length && (
        <p className="mt-4 text-xs text-fg-muted">{t("myTasks.shown", { shown: rows.length, total: assigned.total })}</p>
      )}
    </div>
  );
}

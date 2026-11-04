import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTimeZone, getTranslations } from "next-intl/server";
import { TodayNoteSection } from "@/components/journal/today-note-section";
import { AssignedSection } from "@/components/workspace/assigned-section";
import { HomeDashboard } from "@/components/workspace/home-dashboard";
import { HomeFigures } from "@/components/workspace/home-figures";
import { QuickCreate } from "@/components/workspace/quick-create";
import { PlaceTopBar } from "@/components/place-top-bar";
import { HouseIcon } from "@/components/sidebar/rail-icons";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { dayString, localDay } from "@/lib/time-zone";
import { getMembership, isGuest } from "@/server/access";
import { assignedRows } from "@/server/assigned";
import { homeDashboard } from "@/server/home-dashboard";
import { listDailyNotes } from "@/server/journal";
import { recentlyViewedPages } from "@/server/page-views";
import { parentTitles, recentPages } from "@/server/pages";
import { countPendingFor } from "@/server/pending-changes";
import { workspaceResumePath } from "@/server/open-on-start";
import { requireWorkspaceSession } from "@/server/session";
import { topLevelAccess } from "@/server/workspaces";

export default async function WorkspaceHome({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ resume?: string | string[] }>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const { user } = await requireWorkspaceSession(workspaceId);
  // Switching workspaces (`?resume`, the sidebar's menu) goes back to the page opened last there
  // for those who start on the page they opened last (lib/open-on-start.ts).
  if (query.resume !== undefined) {
    const path = await workspaceResumePath(user.id, workspaceId);
    if (path) redirect(path);
  }
  const now = new Date();
  // Today in the viewer's time zone, so a row due today counts as today wherever they are.
  const timeZone = await getTimeZone();
  const today = dayString(localDay(now.getTime(), timeZone));
  const [pages, viewed, membership, topLevel, assigned, dailyNotes, approvals] = await Promise.all([
    recentPages(user.id, workspaceId, 8),
    // Null while the person's views aren't recorded: then only the pages last edited show.
    recentlyViewedPages(user.id, workspaceId, 6),
    getMembership(user.id, workspaceId),
    topLevelAccess(user.id, workspaceId),
    assignedRows(user.id, workspaceId, today, timeZone),
    listDailyNotes(user.id, workspaceId, { to: today, limit: 5 }),
    countPendingFor(user.id, workspaceId),
  ]);
  const guest = !membership || isGuest(membership.role);
  const owner = membership?.role === "owner";
  const [t, tc, format, parents, dashboard, tSidebar] = await Promise.all([
    getTranslations("home"),
    getTranslations("common"),
    getFormatter(),
    parentTitles(user.id, [...new Set([...pages, ...(viewed ?? [])].map((p) => p.id))]),
    guest ? null : homeDashboard(user.id, workspaceId, { owner }),
    getTranslations("sidebar"),
  ]);

  return (
    <>
    <PlaceTopBar icon={<HouseIcon />} title={tSidebar("tabs.home")} />
    <div className="page-gutter pt-6 pb-12">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl leading-tight tracking-tight md:text-[28px]">{t("hello", { name: user.name.split(/\s+/)[0] })}</h1>
          <p className="text-sm text-fg-muted">
            {format.dateTime(now, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone })}
          </p>
        </div>
        {topLevel && <QuickCreate workspaceId={workspaceId} />}
      </header>

      <div className="mt-8 space-y-10">
        {/* Guests' work is what is assigned to them, listed below. */}
        {!guest && (
          <HomeFigures
            workspaceId={workspaceId}
            counts={assigned.counts}
            total={assigned.total}
            approvals={approvals}
          />
        )}

        {dashboard && <HomeDashboard workspaceId={workspaceId} widgets={dashboard.widgets} period={dashboard.period} canEdit={owner} />}

        {viewed && viewed.length > 0 && (
          <section className="space-y-3" aria-labelledby="viewed-heading">
            <h2 id="viewed-heading" className="text-base font-semibold">
              {t("jumpBackIn")}
            </h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {viewed.map((p) => {
                const parent = parents.get(p.id);
                return (
                  <li key={p.id} className="min-w-0">
                    <Link
                      href={`/w/${workspaceId}/p/${p.id}`}
                      className="flex h-full flex-col gap-2 rounded-lg bg-bg-subtle px-3.5 py-3 text-sm hover:bg-bg-hover"
                    >
                      <PageIcon icon={p.icon} kind={p.kind} className="flex h-4 w-4 items-center text-sm text-fg-muted" />
                      <span className="line-clamp-2 font-medium break-words">{pageLabel(p.title, tc("untitled"))}</span>
                      <span className="mt-auto flex min-w-0 flex-col text-xs text-fg-faint">
                        {parent !== undefined && <span className="truncate">{pageLabel(parent, tc("untitled"))}</span>}
                        <span className="truncate">{format.relativeTime(p.viewedAt, now)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
          <div className="min-w-0 space-y-10">
            {/* Guests see it only once something is assigned to them. */}
            {(assigned.groups.length > 0 || !guest) && <AssignedSection workspaceId={workspaceId} assigned={assigned} today={today} />}
          </div>
          <div className="min-w-0 space-y-10">
            {/* Daily notes are private top-level pages: for those who may add them. */}
            {topLevel && <TodayNoteSection workspaceId={workspaceId} today={today} notes={dailyNotes} />}

            <section className="space-y-3" aria-labelledby="recent-heading">
              <h2 id="recent-heading" className="text-base font-semibold">
                {t("recent")}
              </h2>
              {pages.length === 0 ? (
                <p className="text-sm text-fg-muted">{t(guest ? "emptyGuest" : "empty")}</p>
              ) : (
                <ul className="-mx-2">
                  {pages.map((p) => {
                    const parent = parents.get(p.id);
                    return (
                      <li key={p.id}>
                        <Link
                          href={`/w/${workspaceId}/p/${p.id}`}
                          className="flex min-h-10 items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-bg-hover"
                        >
                          <PageIcon icon={p.icon} kind={p.kind} className="flex w-4 shrink-0 justify-center text-sm text-fg-muted" />
                          <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
                            <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
                            {parent !== undefined && <span className="truncate text-xs text-fg-faint">{pageLabel(parent, tc("untitled"))}</span>}
                          </span>
                          <span className="shrink-0 text-xs text-fg-faint tabular-nums">{format.relativeTime(p.updatedAt, now)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

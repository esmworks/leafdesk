import Link from "next/link";
import { getFormatter, getTimeZone, getTranslations } from "next-intl/server";
import { AssignedSection } from "@/components/workspace/assigned-section";
import { QuickCreate } from "@/components/workspace/quick-create";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { dayString, localDay } from "@/lib/time-zone";
import { getMembership, isGuest } from "@/server/access";
import { assignedRows } from "@/server/assigned";
import { recentPages } from "@/server/pages";
import { requireWorkspaceSession } from "@/server/session";
import { topLevelAccess } from "@/server/workspaces";

export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  const now = new Date();
  // Today in the viewer's time zone, so a row due today counts as today wherever they are.
  const timeZone = await getTimeZone();
  const today = dayString(localDay(now.getTime(), timeZone));
  const [pages, membership, topLevel, assigned] = await Promise.all([
    recentPages(user.id, workspaceId, 12),
    getMembership(user.id, workspaceId),
    topLevelAccess(user.id, workspaceId),
    assignedRows(user.id, workspaceId, today),
  ]);
  const [t, tc, format] = await Promise.all([getTranslations("home"), getTranslations("common"), getFormatter()]);
  const guest = !membership || isGuest(membership.role);

  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const count = (key: string) => assigned.groups.find((g) => g.key === key)?.rows.length ?? 0;
  const stats = [
    { label: t("statOverdue"), value: count("overdue"), alert: count("overdue") > 0 },
    { label: t("statToday"), value: count("today"), alert: false },
    { label: t("statOpen"), value: assigned.total, alert: false },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 pt-14 pb-12 md:px-8 md:pt-12">
      <header className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t(greeting, { name: user.name.split(/\s+/)[0] })}</h1>
          <p className="text-sm text-fg-muted">
            {format.dateTime(now, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone })}
          </p>
        </div>
        {topLevel && <QuickCreate workspaceId={workspaceId} />}
      </header>

      {!guest && (
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-border px-4 py-3">
              <dd className={`text-2xl font-semibold tabular-nums ${s.alert ? "text-danger" : ""}`}>{s.value}</dd>
              <dt className="mt-0.5 text-xs text-fg-muted">{s.label}</dt>
            </div>
          ))}
        </dl>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          {assigned.groups.length > 0 ? (
            <AssignedSection workspaceId={workspaceId} assigned={assigned} today={today} />
          ) : (
            !guest && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">{t("assigned")}</h2>
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
                  {t("assignedEmpty")}
                </p>
              </section>
            )
          )}
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("recent")}</h2>
          {pages.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
              {t(guest ? "emptyGuest" : "empty")}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {pages.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/w/${workspaceId}/p/${p.id}`}
                    className="flex items-center gap-2.5 px-4 py-3 text-sm hover:bg-bg-hover md:py-2.5"
                  >
                    <PageIcon icon={p.icon} kind={p.kind} className="text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate">{pageLabel(p.title, tc("untitled"))}</span>
                    <span className="shrink-0 text-xs text-fg-muted">{format.relativeTime(p.updatedAt, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

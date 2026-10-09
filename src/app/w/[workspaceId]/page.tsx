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

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 pt-14 pb-12 md:px-6 md:pt-12">
      <header className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("hello", { name: user.name.split(/\s+/)[0] })}</h1>
          <p className="text-sm text-fg-muted">
            {format.dateTime(now, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone })}
          </p>
        </div>
        {topLevel && <QuickCreate workspaceId={workspaceId} />}
      </header>

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

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("recent")}</h2>
        {pages.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
            {t(guest ? "emptyGuest" : "empty")}
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {pages.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${workspaceId}/p/${p.id}`}
                  className="flex h-full items-start gap-2.5 rounded-md border border-border px-3.5 py-3 text-sm hover:bg-bg-hover"
                >
                  <PageIcon icon={p.icon} kind={p.kind} className="mt-0.5 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words">{pageLabel(p.title, tc("untitled"))}</span>
                    <span className="mt-1 block text-xs text-fg-muted">{format.relativeTime(p.updatedAt, now)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

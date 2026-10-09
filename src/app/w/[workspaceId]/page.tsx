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
  const today = dayString(localDay(now.getTime(), await getTimeZone()));
  const [pages, membership, topLevel, assigned] = await Promise.all([
    recentPages(user.id, workspaceId, 12),
    getMembership(user.id, workspaceId),
    topLevelAccess(user.id, workspaceId),
    assignedRows(user.id, workspaceId, today),
  ]);
  const [t, tc, format] = await Promise.all([getTranslations("home"), getTranslations("common"), getFormatter()]);
  const guest = !membership || isGuest(membership.role);

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 pt-14 pb-12 md:px-6 md:pt-12">
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("welcome", { name: user.name.split(/\s+/)[0] })}</h1>
        {topLevel && <QuickCreate workspaceId={workspaceId} />}
      </div>

      <AssignedSection workspaceId={workspaceId} assigned={assigned} today={today} />

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
  );
}

import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { OptionChip } from "@/components/database/property-cell";
import { PageIcon } from "@/components/ui";
import type { AssignedGroupKey } from "@/lib/assigned";
import { pageLabel } from "@/lib/labels";
import type { AssignedRows } from "@/server/assigned";

/** Overdue rows stand out; the rest stay quiet. */
const tone = (key: AssignedGroupKey) => (key === "overdue" ? "text-danger" : "text-fg-muted");

/** The home page's list of open database rows assigned to the viewer, by when they are due. */
export async function AssignedSection({
  workspaceId,
  assigned,
  today,
}: {
  workspaceId: string;
  assigned: AssignedRows;
  today: string;
}) {
  if (!assigned.groups.length) return null;
  const [t, tc, format] = await Promise.all([getTranslations("home"), getTranslations("common"), getFormatter()]);
  const shown = assigned.groups.reduce((n, g) => n + g.rows.length, 0);
  const year = today.slice(0, 4);
  const dateLabel = (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), {
      month: "short",
      day: "numeric",
      ...(date.slice(0, 4) === year ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });

  return (
    <section className="space-y-3" aria-labelledby="assigned-heading">
      <h2 id="assigned-heading" className="text-sm font-semibold">
        {t("assigned")}
      </h2>
      {assigned.groups.map((group) => (
        <div key={group.key} className="space-y-1.5">
          <h3 className={`text-xs font-medium ${tone(group.key)}`}>
            {t(`assignedGroups.${group.key}`)} <span className="font-normal text-fg-muted">{group.rows.length}</span>
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {group.rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/w/${workspaceId}/p/${row.id}`}
                  className="flex items-center gap-2.5 px-4 py-3 text-sm hover:bg-bg-hover md:py-2.5"
                >
                  <PageIcon icon={row.icon} kind={row.kind} className="text-fg-muted" />
                  <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
                    <span className="truncate">{pageLabel(row.title, tc("untitled"))}</span>
                    {row.databaseTitle !== null && (
                      <span className="truncate text-xs text-fg-muted">{pageLabel(row.databaseTitle, tc("untitled"))}</span>
                    )}
                  </span>
                  {/* Phones leave the status out so the title has room. */}
                  {row.status && (
                    <span className="hidden shrink-0 sm:inline-flex">
                      <OptionChip option={row.status} dot />
                    </span>
                  )}
                  {row.date && (
                    <span className={`shrink-0 text-xs tabular-nums ${tone(group.key)}`}>
                      {dateLabel(row.date)}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {assigned.total > shown && (
        <p className="text-xs text-fg-muted">{t("assignedMore", { shown, total: assigned.total })}</p>
      )}
    </section>
  );
}

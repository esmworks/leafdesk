import Link from "next/link";
import { getTranslations } from "next-intl/server";

type Figure = { key: "open" | "overdue" | "week" | "approvals"; value: number; href: string; note: string; alert?: boolean };

/**
 * The four figures at the top of the home page, the viewer's own: their open tasks, those overdue
 * and due within the week (server/assigned.ts counts), and the changes waiting for their answer.
 * Each opens where they are dealt with.
 */
export async function HomeFigures({
  workspaceId,
  counts,
  total,
  approvals,
}: {
  workspaceId: string;
  counts: { overdue: number; today: number; next7: number };
  total: number;
  approvals: number;
}) {
  const t = await getTranslations("home.figures");
  const tasks = `/w/${workspaceId}/tasks`;
  const figures: Figure[] = [
    { key: "open", value: total, href: tasks, note: t("openNote", { count: counts.today }) },
    { key: "overdue", value: counts.overdue, href: tasks, note: t(counts.overdue ? "overdueNote" : "overdueNone"), alert: counts.overdue > 0 },
    { key: "week", value: counts.today + counts.next7, href: tasks, note: t("weekNote") },
    { key: "approvals", value: approvals, href: `/w/${workspaceId}/review`, note: t(approvals ? "approvalsNote" : "approvalsNone") },
  ];
  return (
    <ul aria-label={t("label")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {figures.map((f) => (
        <li key={f.key} className="min-w-0">
          <Link href={f.href} className="flex h-full flex-col rounded-lg bg-bg-subtle px-4 py-3.5 hover:bg-bg-hover high-contrast:border high-contrast:border-border">
            <span className="truncate text-[13px] text-fg-muted">{t(f.key)}</span>
            <span className={`mt-1 text-[28px] leading-9 font-semibold tabular-nums ${f.alert ? "text-danger" : "text-fg"}`}>{f.value}</span>
            <span className="mt-0.5 truncate text-xs text-fg-faint">{f.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

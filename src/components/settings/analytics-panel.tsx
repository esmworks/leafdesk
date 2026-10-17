import { Download, Lock } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { UserAvatar } from "@/components/user-avatar";
import { ANALYTICS_PERIODS, type AnalyticsReport, type AnalyticsTable } from "@/lib/analytics";

// A server component (plain links, nothing to hydrate), so it cannot pull `cn` from the client-only ui module.
const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/** Settings > Analytics: the counts of `report` (see server/analytics.ts), for owners. */
export async function AnalyticsPanel({ workspaceId, report, now }: { workspaceId: string; report: AnalyticsReport; now: Date }) {
  const [ts, t, tm, tc, format] = await Promise.all([
    getTranslations("settings"),
    getTranslations("settings.analytics"),
    getTranslations("settings.members"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const base = `/w/${workspaceId}/settings`;
  const csv = (table: AnalyticsTable) => `${base}/analytics.csv?days=${report.days}&table=${table}`;
  const when = (at: Date | null) =>
    at ? (
      <time dateTime={at.toISOString()} title={format.dateTime(at, { dateStyle: "medium", timeStyle: "short" })}>
        {format.relativeTime(at, now)}
      </time>
    ) : (
      <span className="text-fg-faint">{t("neverEdited")}</span>
    );
  const th = "px-4 py-2.5 text-start font-normal";
  const num = "px-4 py-3 text-end tabular-nums";

  return (
    <div>
      <SettingsHeader title={ts("nav.analytics")} description={t("description")} />

      <div className="space-y-10">
        <div className="space-y-4">
          <nav aria-label={t("periods")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
            {ANALYTICS_PERIODS.map((days) => (
              <Link
                key={days}
                href={`${base}?tab=analytics&days=${days}`}
                aria-current={days === report.days ? "page" : undefined}
                className={cn(
                  "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors",
                  days === report.days ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                )}
              >
                {t("period", { days })}
              </Link>
            ))}
          </nav>

          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat label={t("activeMembers")} value={t("activeOf", { active: report.activeMembers, total: report.memberCount })} />
            <Stat label={t("edits")} value={format.number(report.totalEdits)} />
            <Stat label={t("pagesEdited")} value={format.number(report.pagesEdited)} />
          </dl>
          <p className="text-xs text-fg-muted">{t("howCounted")}</p>
        </div>

        <SettingsGroup
          title={t("peopleHeading")}
          description={t("peopleDescription")}
          action={<CsvLink href={csv("members")} label={t("exportPeople")} />}
          bare
        >
          <div className="relative overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                <tr>
                  <th scope="col" className={th}>{t("columns.person")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{t("columns.role")}</th>
                  <th scope="col" className={cn(th, "w-24 text-end")}>{t("columns.edits")}</th>
                  <th scope="col" className={cn(th, "w-24 text-end")}>{t("columns.pages")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{t("columns.lastEdit")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.people.map((p) => (
                  <tr key={p.userId}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <UserAvatar name={p.name || p.email} image={p.image} size="md" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="truncate text-xs text-fg-muted">{p.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{tm(`roles.${p.role}`)}</td>
                    <td className={num}>{format.number(p.edits)}</td>
                    <td className={num}>{format.number(p.pages)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-fg-muted">{when(p.lastEditAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsGroup>

        <SettingsGroup
          title={t("pagesHeading")}
          description={t("pagesDescription")}
          action={report.pages.length > 0 && <CsvLink href={csv("pages")} label={t("exportPages")} />}
          bare
        >
          {report.pages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("noEdits")}</p>
          ) : (
            <div className="relative overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className={th}>{t("columns.page")}</th>
                    <th scope="col" className={cn(th, "w-24 text-end")}>{t("columns.edits")}</th>
                    <th scope="col" className={cn(th, "w-24 text-end")}>{t("columns.editors")}</th>
                    <th scope="col" className={cn(th, "w-36")}>{t("columns.lastEdit")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.pages.map((p, i) => (
                    <tr key={p.id ?? `private-${i}`}>
                      <td className="max-w-0 px-4 py-2">
                        {p.id ? (
                          <Link
                            href={`/w/${workspaceId}/p/${p.id}`}
                            className="-mx-1.5 flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-bg-hover"
                          >
                            <PageIcon icon={p.icon} kind={p.kind ?? undefined} className="text-fg-muted" />
                            <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
                          </Link>
                        ) : (
                          <span className="flex h-7 items-center gap-2 text-fg-muted">
                            <Lock className="h-4 w-4 shrink-0" aria-hidden />
                            {t("privatePage")}
                          </span>
                        )}
                      </td>
                      <td className={num}>{format.number(p.edits)}</td>
                      <td className={num}>{format.number(p.editors)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">{when(p.lastEditAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SettingsGroup>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-bg-subtle/60 px-4 py-3">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function CsvLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      <Download className="h-4 w-4" />
    </a>
  );
}

import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import type { AiUsageMonth, AiUsageReport, AiUsageTotals } from "@/lib/ai-usage";
import { AiLimitForm } from "./ai-limit-form";

// A server component (plain links, nothing to hydrate), so it cannot pull `cn` from the client-only ui module.
const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/**
 * Settings > AI usage, for owners: this month's cost against the limits, the owners' monthly limit,
 * and what each month cost by feature and model (see server/ai-usage.ts). `month` is the month shown
 * in detail ("2026-10"), this one when it isn't among the months.
 */
export async function AiUsagePanel({ workspaceId, report, month }: { workspaceId: string; report: AiUsageReport; month?: string }) {
  const [ts, t, format] = await Promise.all([getTranslations("settings"), getTranslations("settings.aiUsage"), getFormatter()]);
  const current = report.months[0];
  const shown = report.months.find((m) => m.month === month) ?? current;
  const usd = (n: number) =>
    format.number(n, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 4 : 2 });
  const tokens = (n: number) => format.number(n, { notation: "compact", maximumFractionDigits: 1 });
  const monthName = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return format.dateTime(new Date(Date.UTC(y, mm - 1, 1)), { year: "numeric", month: "long", timeZone: "UTC" });
  };
  const { limit, spent } = report;
  const th = "px-4 py-2.5 text-start font-normal";
  const num = "px-4 py-3 text-end tabular-nums";
  const numHead = cn(th, "w-24 text-end");

  const limitDescription = [
    t("limitHelp"),
    limit.server !== null && (report.ownAccount ? t("serverLimitOwnAccount", { limit: usd(limit.server) }) : t("serverLimit", { limit: usd(limit.server) })),
  ]
    .filter(Boolean)
    .join(" ");
  // The limit that holds this workspace's requests now, for the meter.
  const cap = [limit.workspace, report.ownAccount ? null : limit.server].filter((n): n is number => n !== null);
  const capUsd = cap.length ? Math.min(...cap) : null;
  const capSpent = capUsd !== null && capUsd === limit.workspace ? spent.totalUsd : spent.serverUsd;

  const totalsHead = (
    <>
      <th scope="col" className={numHead}>{t("columns.requests")}</th>
      <th scope="col" className={numHead}>{t("columns.input")}</th>
      <th scope="col" className={numHead}>{t("columns.cache")}</th>
      <th scope="col" className={numHead}>{t("columns.output")}</th>
      <th scope="col" className={cn(th, "w-28 text-end")}>{t("columns.cost")}</th>
    </>
  );
  const totalsCells = (row: AiUsageTotals) => (
    <>
      <td className={num}>{format.number(row.requests)}</td>
      <td className={num}>{tokens(row.inputTokens)}</td>
      <td className={num} title={t("cacheTitle", { read: format.number(row.cacheReadTokens), write: format.number(row.cacheWriteTokens) })}>
        {tokens(row.cacheReadTokens + row.cacheWriteTokens)}
      </td>
      <td className={num}>{tokens(row.outputTokens)}</td>
      <td className={cn(num, "font-medium")}>{usd(row.costUsd)}</td>
    </>
  );

  return (
    <div>
      <SettingsHeader title={ts("nav.aiUsage")} description={t("description")} />

      <div className="space-y-10">
        <div className="space-y-4">
          {report.reached && (
            <p role="status" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              {report.reached === "workspace" ? t("reachedWorkspace") : t("reachedServer")}
            </p>
          )}
          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat label={t("thisMonth")} value={usd(current.total.costUsd)} />
            <Stat
              label={t("limitLeft")}
              value={capUsd === null ? t("noLimit") : usd(Math.max(0, capUsd - capSpent))}
              meter={capUsd === null ? null : Math.min(1, capSpent / capUsd)}
              hint={capUsd === null ? undefined : t("ofLimit", { limit: usd(capUsd) })}
            />
            <Stat label={t("requestsThisMonth")} value={format.number(current.total.requests)} />
          </dl>
          <p className="text-xs text-fg-muted">{t("howCounted")}</p>
        </div>

        <SettingsGroup title={t("limitHeading")}>
          <AiLimitForm workspaceId={workspaceId} limit={limit.workspace} description={limitDescription} />
        </SettingsGroup>

        <SettingsGroup title={t("monthsHeading")} description={t("monthsDescription")} bare>
          <div className="relative overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                <tr>
                  <th scope="col" className={th}>{t("columns.month")}</th>
                  <th scope="col" className={numHead}>{t("columns.requests")}</th>
                  <th scope="col" className={numHead}>{t("columns.tokens")}</th>
                  <th scope="col" className={cn(th, "w-28 text-end")}>{t("columns.cost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.months.map((m) => (
                  <tr key={m.month} className={m.month === shown.month ? "bg-bg-active/60" : undefined}>
                    <td className="px-4 py-2">
                      <Link
                        href={`/w/${workspaceId}/settings?tab=aiUsage&month=${m.month}`}
                        aria-current={m.month === shown.month ? "true" : undefined}
                        className="-mx-1.5 flex h-7 items-center rounded-md px-1.5 hover:bg-bg-hover"
                      >
                        {monthName(m.month)}
                        {m.month === current.month && <span className="ms-2 text-xs text-fg-muted">{t("current")}</span>}
                      </Link>
                    </td>
                    <td className={num}>{format.number(m.total.requests)}</td>
                    <td className={num}>{tokens(allTokens(m.total))}</td>
                    <td className={cn(num, "font-medium")}>{usd(m.total.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsGroup>

        <MonthDetail
          month={shown}
          title={t("detailHeading", { month: monthName(shown.month) })}
          ownShare={shown.ownAccountCostUsd > 0 ? t("ownAccountShare", { cost: usd(shown.ownAccountCostUsd) }) : null}
          empty={t("empty")}
        >
          {shown.total.requests > 0 && (
            <>
              <div className="relative overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                    <tr>
                      <th scope="col" className={th}>{t("columns.feature")}</th>
                      {totalsHead}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {shown.byGroup.map((row) => (
                      <tr key={row.group}>
                        <td className="px-4 py-3">{t(`groups.${row.group}`)}</td>
                        {totalsCells(row)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="relative overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                    <tr>
                      <th scope="col" className={th}>{t("columns.model")}</th>
                      {totalsHead}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {shown.byModel.map((row) => (
                      <tr key={row.model}>
                        <td className="max-w-0 truncate px-4 py-3" title={row.model}>
                          {row.model}
                        </td>
                        {totalsCells(row)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </MonthDetail>
      </div>
    </div>
  );
}

const allTokens = (t: AiUsageTotals) => t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;

function MonthDetail({ month, title, ownShare, empty, children }: { month: AiUsageMonth; title: string; ownShare: string | null; empty: string; children: ReactNode }) {
  return (
    <SettingsGroup title={title} description={ownShare ?? undefined} bare>
      {month.total.requests === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{empty}</p>
      ) : (
        <div className="space-y-4">{children}</div>
      )}
    </SettingsGroup>
  );
}

function Stat({ label, value, meter, hint }: { label: string; value: ReactNode; meter?: number | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-subtle/60 px-4 py-3">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {meter != null && (
        <dd className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-hover" role="presentation">
            <div className={cn("h-full rounded-full", meter >= 1 ? "bg-danger" : meter >= 0.8 ? "bg-amber-400" : "bg-accent")} style={{ width: `${Math.round(meter * 100)}%` }} />
          </div>
          {hint && <div className="mt-1 text-xs text-fg-muted">{hint}</div>}
        </dd>
      )}
    </div>
  );
}

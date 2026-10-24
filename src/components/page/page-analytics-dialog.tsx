"use client";

import { X } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { pageAnalyticsAction } from "@/app/actions/page-views";
import { cn, Dialog, IconButton } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { ANALYTICS_PERIODS, DEFAULT_ANALYTICS_PERIOD, type AnalyticsPeriod } from "@/lib/analytics";
import type { DailyViews, PageAnalytics, PagePerson } from "@/lib/page-views";

/**
 * The page menu's "Analytics": how often the page was opened over the last 7, 30 or 90 days, by
 * whom, and who edited it (server/page-views.ts pageAnalytics), for the workspace's owners and
 * members who may edit it. Loaded with the menu's first use, not with every page.
 */
export default function PageAnalyticsDialog({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const t = useTranslations("page.analytics");
  const tc = useTranslations("common");
  const [days, setDays] = useState<AnalyticsPeriod>(DEFAULT_ANALYTICS_PERIOD);
  const [result, setResult] = useState<{ days: AnalyticsPeriod; data: PageAnalytics | null; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    pageAnalyticsAction(pageId, days)
      .then((r) => (r.ok ? { days, data: r.data, error: null } : { days, data: null, error: r.error }))
      .catch(() => ({ days, data: null, error: t("failed") }))
      .then((next) => {
        if (live) setResult(next);
      });
    return () => {
      live = false;
    };
  }, [pageId, days, t]);

  const data = result?.data ?? null;
  const loading = !result || result.days !== days;

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t("period")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
            {ANALYTICS_PERIODS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={d === days}
                onClick={() => setDays(d)}
                className={cn(
                  "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors",
                  d === days ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                )}
              >
                {t("days", { days: d })}
              </button>
            ))}
          </div>
          <IconButton label={tc("close")} className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <div className={cn("max-h-[70vh] space-y-6 overflow-y-auto p-5 transition-opacity", loading && data && "opacity-60")} aria-busy={loading}>
        {result?.error ? (
          <p role="alert" className="text-sm text-danger">
            {result.error}
          </p>
        ) : !data ? (
          <p className="py-10 text-center text-sm text-fg-muted">{tc("loading")}</p>
        ) : (
          <Report data={data} />
        )}
      </div>
    </Dialog>
  );
}

function Report({ data }: { data: PageAnalytics }) {
  const t = useTranslations("page.analytics");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const when = (at: Date) => (
    <time dateTime={at.toISOString()} title={format.dateTime(at, { dateStyle: "medium", timeStyle: "short" })}>
      {format.relativeTime(at, now)}
    </time>
  );

  return (
    <>
      {data.recording ? (
        <section className="space-y-3">
          <dl className="grid grid-cols-2 gap-3">
            <Stat label={t("views")} value={format.number(data.views)} />
            <Stat label={t("viewers")} value={format.number(data.viewers)} />
          </dl>
          <DailyChart daily={data.daily} />
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-fg-muted">{t("notRecorded")}</p>
      )}

      {data.recording && (
        <People
          heading={t("viewedBy")}
          empty={t("noViews")}
          people={data.people.map((p) => ({ ...p, detail: <>{t("viewCount", { count: p.views })} · {when(p.lastViewedAt)}</> }))}
        />
      )}
      <People
        heading={t("editedBy")}
        empty={t("noEdits")}
        people={data.editors.map((p) => ({ ...p, detail: <>{t("editCount", { count: p.edits })} · {when(p.lastEditAt)}</> }))}
      />
      <p className="text-xs text-fg-muted">{data.recording ? t("howCounted") : t("howEditsCounted")}</p>
    </>
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

/** Views per day as bars, the busiest day full height; each bar names its day and count. */
function DailyChart({ daily }: { daily: DailyViews[] }) {
  const t = useTranslations("page.analytics");
  const format = useFormatter();
  const most = Math.max(1, ...daily.map((d) => d.views));
  const label = (day: string) => format.dateTime(new Date(`${day}T00:00:00Z`), { month: "short", day: "numeric", timeZone: "UTC" });
  if (daily.length === 0) return null;
  return (
    <figure className="space-y-1.5">
      <div role="img" aria-label={t("chartLabel")} className="flex h-24 items-end gap-px rounded-lg border border-border px-2 pt-2">
        {daily.map((d) => (
          <div
            key={d.day}
            title={t("dayViews", { day: label(d.day), count: d.views })}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <div
              className={cn("w-full rounded-t-sm", d.views > 0 ? "bg-accent" : "bg-border")}
              style={{ height: d.views > 0 ? `${Math.max(4, (d.views / most) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-fg-muted">
        <span>{label(daily[0].day)}</span>
        <span>{label(daily[daily.length - 1].day)}</span>
      </figcaption>
    </figure>
  );
}

function People({ heading, empty, people }: { heading: string; empty: string; people: (PagePerson & { detail: ReactNode })[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{heading}</h3>
      {people.length === 0 ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {people.map((p) => (
            <li key={p.userId} className="flex items-center gap-2.5 px-3 py-2">
              <UserAvatar name={p.name || p.email} image={p.image} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name || p.email}</div>
                <div className="truncate text-xs text-fg-muted">{p.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

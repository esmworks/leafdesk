"use client";

import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { Floating, useFloating } from "@/components/database/floating";
import { useViewerTimeZone } from "@/components/database/use-today";
import { Button, cn, MenuItem, MenuSeparator, menuFieldClass } from "@/components/ui";
import {
  ALL_TIME,
  changeTone,
  DASHBOARD_PERIODS,
  nameRange,
  parseDashboardPeriod,
  PERIOD_LABELS,
  periodRange,
  readDashboardPeriod,
  samePeriod,
  type Comparison,
  type DashboardPeriod,
  type DayRange,
  type FigureChange,
} from "@/lib/dashboard-period";

/**
 * A dashboard's period above its grid (see lib/dashboard-period). Everyone picks a period for
 * themselves, as with a view's search; editors may then save it as the one everybody starts with.
 */

/** The period a dashboard shows: the stored one until the reader picks another. */
export function useDashboardPeriod(stored: string | undefined) {
  const saved = parseDashboardPeriod(stored);
  const [picked, setPicked] = useState<DashboardPeriod | null>(null);
  const period = picked ?? saved;
  return { period, saved, picked: picked !== null && !samePeriod(picked, saved), pick: setPicked, reset: () => setPicked(null) };
}

/** Days of a range in words, as short as they go: "Oct 2026", "Q3 2026", "2026", "1–9 Oct 2026". */
export function useRangeName() {
  const format = useFormatter();
  const t = useTranslations("page.dashboard.period");
  return (range: DayRange) => nameRange(range, format, (values) => t("quarter", values));
}

/** A period's name: "This month", "All time", or a custom range's days. */
export function usePeriodName() {
  const t = useTranslations("page.dashboard.period");
  const rangeName = useRangeName();
  return (period: DashboardPeriod) => {
    if (period.kind === "all") return t("all");
    if (period.kind === "custom") return rangeName(period);
    return t(PERIOD_LABELS[period.kind]);
  };
}

export function PeriodBar({
  period,
  onPick,
  changed,
  onSave,
  onReset,
}: {
  period: DashboardPeriod;
  onPick: (period: DashboardPeriod) => void;
  /** The reader picked a period other than the saved one. */
  changed: boolean;
  /** Editors: make the picked period the one everybody starts with. */
  onSave?: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("page.dashboard.period");
  const menu = useFloating<HTMLButtonElement>();
  const timeZone = useViewerTimeZone();
  const now = useNow({ updateInterval: 60_000 });
  const periodName = usePeriodName();
  const rangeName = useRangeName();
  const range = periodRange(period, now, timeZone);
  const [custom, setCustom] = useState(false);
  const choose = (next: DashboardPeriod) => {
    menu.close();
    setCustom(false);
    onPick(next);
  };
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Button ref={menu.ref} size="sm" variant="secondary" onClick={menu.toggle} aria-haspopup="menu" aria-expanded={menu.open} title={t("label")}>
        <CalendarRange className="h-3.5 w-3.5 text-fg-muted" />
        {periodName(period)}
        <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
      </Button>
      {range && period.kind !== "custom" && <span className="text-xs text-fg-muted">{rangeName(range)}</span>}
      {changed && (
        <>
          {onSave && (
            <Button size="sm" variant="ghost" onClick={onSave} title={t("saveHint")}>
              {t("save")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onReset}>
            {t("reset")}
          </Button>
        </>
      )}
      <Floating open={menu.open} anchor={menu.el} onClose={() => (menu.close(), setCustom(false))}>
        <div className="w-60" role="menu">
          {custom ? (
            <CustomRange initial={range ?? undefined} onApply={(start, end) => choose({ kind: "custom", start, end })} onCancel={() => setCustom(false)} />
          ) : (
            <>
              {DASHBOARD_PERIODS.map((p, i) => (
                <div key={p}>
                  {i === 4 && <MenuSeparator />}
                  <MenuItem onClick={() => choose({ kind: p })} trailing={period.kind === p ? <Check className="h-3.5 w-3.5" /> : undefined}>
                    {t(PERIOD_LABELS[p])}
                  </MenuItem>
                </div>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => setCustom(true)} trailing={period.kind === "custom" ? <Check className="h-3.5 w-3.5" /> : undefined}>
                {t("custom")}
              </MenuItem>
              <MenuItem onClick={() => choose(ALL_TIME)} trailing={period.kind === "all" ? <Check className="h-3.5 w-3.5" /> : undefined}>
                {t("all")}
              </MenuItem>
            </>
          )}
        </div>
      </Floating>
    </div>
  );
}

function CustomRange({ initial, onApply, onCancel }: { initial?: DayRange; onApply: (start: string, end: string) => void; onCancel: () => void }) {
  const t = useTranslations("page.dashboard.period");
  const [start, setStart] = useState(initial?.start ?? "");
  const [end, setEnd] = useState(initial?.end ?? "");
  const valid = readDashboardPeriod(`${start}/${end}`)?.kind === "custom";
  return (
    <form
      className="flex flex-col gap-2 p-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onApply(start, end);
      }}
    >
      {(["from", "to"] as const).map((which) => (
        <label key={which} className="block text-xs text-fg-muted">
          {t(which)}
          <input
            type="date"
            value={which === "from" ? start : end}
            onChange={(e) => (which === "from" ? setStart : setEnd)(e.target.value)}
            className={cn(menuFieldClass, "mt-0.5")}
          />
        </label>
      ))}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          {t("back")}
        </Button>
        <Button size="sm" type="submit" disabled={!valid}>
          {t("apply")}
        </Button>
      </div>
    </form>
  );
}

/** "+12 % vs Sep 2026", the change tinted by whether that is good (the colors of added and removed text). */
export function ChangeLine({ change, comparison, versus }: { change: FigureChange | null; comparison: Comparison; versus: string }) {
  const t = useTranslations("page.dashboard.period");
  const format = useFormatter();
  if (!change) {
    const none = t("noComparison", { period: versus });
    return (
      <p className="mt-1 truncate text-xs text-fg-faint" title={none}>
        {none}
      </p>
    );
  }
  const tone = changeTone(change, comparison);
  const amount =
    change.by === "points"
      ? t("points", { value: format.number(change.value * 100, { maximumFractionDigits: 1, signDisplay: "exceptZero" }) })
      : format.number(change.value, { style: "percent", maximumFractionDigits: Math.abs(change.value) < 0.1 ? 1 : 0, signDisplay: "exceptZero" });
  return (
    <p className="mt-1 truncate text-xs text-fg-muted" title={`${amount} ${t("versus", { period: versus })}`}>
      <span className={cn("rounded px-1 py-px font-medium", tone === "good" ? "bg-added-bg text-added-fg" : tone === "bad" ? "bg-removed-bg text-removed-fg" : "bg-bg-hover")}>
        {change.value > 0 ? "▲ " : change.value < 0 ? "▼ " : ""}
        {amount}
      </span>{" "}
      {t("versus", { period: versus })}
    </p>
  );
}

"use client";

import { CalendarDays, ChevronLeft, ChevronRight, CircleCheck, List, NotebookPen } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { moveCalendarItemAction } from "@/app/actions/calendar";
import { useCalendarItems } from "@/components/calendar/use-calendar-items";
import { KIND_TINT } from "@/components/calendar/item-tint";
import { PlaceTopBar } from "@/components/place-top-bar";
import { showToast } from "@/components/toast";
import { CalendarIcon } from "@/components/sidebar/rail-icons";
import { useViewerTimeZone } from "@/components/database/use-today";
import { Button, cn } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/use-media-query";
import { dayBlocks, firstDayOfWeek, isAllDay, MINUTES_PER_DAY, weekBars, weekDays } from "@/lib/calendar";
import { droppedDate, isoWeek, itemMinutes, placeItems, type CalendarDrop, type CalendarItem, type CalendarItemKind, type PlacedItem } from "@/lib/calendar-items";
import { isDay } from "@/lib/date-value";
import { dayNumber, dayString, localDay, wallClock } from "@/lib/time-zone";

/** Height of an hour in the week's hours, in pixels. */
const HOUR_HEIGHT = 48;
/** Where the hours open when the week has nothing earlier: 7 in the morning. */
const MORNING = 7 * 60;
/** Minutes a drop on the hours snaps to. */
const SNAP = 15;
/**
 * How long a moved item is drawn where it was dropped while reads still have it where it was: a
 * to-do's date reaches the index only with its page's save.
 */
const MOVE_HOLD_MS = 2 * 60_000;
const KINDS: CalendarItemKind[] = ["event", "meeting", "task"];
const KIND_ICONS: Record<CalendarItemKind, typeof CalendarDays> = { event: CalendarDays, meeting: NotebookPen, task: CircleCheck };

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

type Mode = "week" | "list";

/**
 * The Calendar place: what the person has in a week (server/calendar.ts), on its hours or as a
 * list of its days. The week and the layout are in the address (`?d=`, `?view=list`), changed with
 * `history.replaceState`, so the sidebar's month can open a day and a reload keeps the place.
 */
export function CalendarPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const locale = useLocale();
  const timeZone = useViewerTimeZone();
  const searchParams = useSearchParams();
  const phone = useMediaQuery(PHONE_QUERY);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = localDay(now, timeZone);
  const asked = searchParams.get("d");
  const anchor = isDay(asked) ? dayNumber(asked) : today;
  const viewParam = searchParams.get("view");
  const mode: Mode = viewParam === "list" || viewParam === "week" ? viewParam : phone ? "list" : "week";
  const days = useMemo(() => weekDays(anchor, firstDayOfWeek(locale)), [anchor, locale]);
  const first = days[0];
  const last = days[6];

  const { items, reload } = useCalendarItems(workspaceId, dayString(first), dayString(last));
  // Items dragged elsewhere, by id: where they were dropped and when.
  const [moved, setMoved] = useState<Record<string, { date: string; at: number }>>({});
  const shown = useMemo(
    () => items?.map((item) => (moved[item.id] && moved[item.id].at > now - MOVE_HOLD_MS ? { ...item, date: moved[item.id].date } : item)) ?? [],
    [items, moved, now],
  );
  const placed = useMemo(() => placeItems(shown, timeZone), [shown, timeZone]);

  const move = async (item: CalendarItem, date: string) => {
    setMoved((m) => ({ ...m, [item.id]: { date, at: Date.now() } }));
    const result = await moveCalendarItemAction(workspaceId, item.id, date).catch(() => ({ ok: false, error: "failed" }) as const);
    if (!result.ok) {
      setMoved(({ [item.id]: _, ...rest }) => rest);
      showToast({ message: t(`moveErrors.${result.error}`) });
      return;
    }
    reload();
    // A to-do's page saves a moment after its date mention changes.
    setTimeout(reload, 2_500);
  };

  const go = (changes: { d?: number | null; view?: Mode }) => {
    const params = new URLSearchParams(searchParams.toString());
    if (changes.d !== undefined) {
      if (changes.d === null || changes.d === today) params.delete("d");
      else params.set("d", dayString(changes.d));
    }
    if (changes.view) params.set("view", changes.view);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  };

  const heading = format.dateTimeRange(utcDay(first), utcDay(last), { month: "long", year: "numeric", timeZone: "UTC" });
  const clock = (minutes: number) => format.dateTime(new Date(Math.min(minutes, MINUTES_PER_DAY - 1) * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  /** When an item is on `day`, as the list and the blocks say it. */
  const whenOn = (p: PlacedItem, day: number) => {
    if (!p.time || (p.start < day && p.end > day)) return t("allDay");
    if (p.start === day && p.end === day) return p.endMinutes !== null && p.endMinutes > p.startMinutes ? `${clock(p.startMinutes)} – ${clock(p.endMinutes)}` : clock(p.startMinutes);
    if (p.start === day) return t("from", { time: clock(p.startMinutes) });
    return p.endMinutes !== null ? t("until", { time: clock(p.endMinutes) }) : t("allDay");
  };

  return (
    <>
      <PlaceTopBar icon={<CalendarIcon />} title={t("metaTitle")}>
        <Button variant="secondary" size="sm" onClick={() => go({ d: null })} disabled={today >= first && today <= last && !asked}>
          {t("today")}
        </Button>
        <button
          type="button"
          aria-label={t("previousWeek")}
          title={t("previousWeek")}
          onClick={() => go({ d: anchor - 7 })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-icon hover:bg-bg-hover hover:text-fg"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        </button>
        <button
          type="button"
          aria-label={t("nextWeek")}
          title={t("nextWeek")}
          onClick={() => go({ d: anchor + 7 })}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-icon hover:bg-bg-hover hover:text-fg"
        >
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </button>
        <div role="group" aria-label={t("layout")} className="ms-1 flex rounded-md bg-bg-hover p-0.5">
          {(["week", "list"] as const).map((m) => {
            const Icon = m === "week" ? CalendarDays : List;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                aria-label={t(m === "week" ? "weekView" : "listView")}
                title={t(m === "week" ? "weekView" : "listView")}
                onClick={() => go({ view: m })}
                className={cn("flex h-6 items-center gap-1.5 rounded px-2 text-xs text-fg-muted hover:text-fg", mode === m && "bg-bg text-fg shadow-sm")}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="max-sm:hidden">{t(m === "week" ? "weekView" : "listView")}</span>
              </button>
            );
          })}
        </div>
      </PlaceTopBar>
      <div className="page-gutter pt-6 pb-12">
      <header className="mb-4 flex min-w-0 items-baseline gap-3">
        <h1 className="font-display text-2xl leading-tight tracking-tight md:text-3xl">{heading}</h1>
        <span className="shrink-0 text-xs whitespace-nowrap tabular-nums text-fg-faint">{t("week", { number: isoWeek(first + 3) })}</span>
      </header>
      <ul aria-label={t("legend")} className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {KINDS.map((kind) => (
          <li key={kind} className={cn("flex items-center gap-1.5", KIND_TINT[kind])}>
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--opt-bg)" }} />
            {t(`kinds.${kind}`)}
          </li>
        ))}
      </ul>
      {mode === "week" ? (
        <WeekGrid
          days={days}
          placed={placed}
          today={today}
          now={now}
          timeZone={timeZone}
          whenOn={whenOn}
          loaded={items !== null}
          onDrop={(p, drop, grabDays) => {
            const date = droppedDate(p, drop, timeZone, grabDays);
            if (date) void move(p.item, date);
          }}
        />
      ) : (
        <DayList days={days} placed={placed} today={today} whenOn={whenOn} loaded={items !== null} />
      )}
      </div>
    </>
  );
}

type WhenOn = (p: PlacedItem, day: number) => string;

/** An item being dragged: how many days after its first and minutes after its start it was picked up at. */
type Drag = { placed: PlacedItem; grabDays: number; grabMinutes: number };

/** Where along a row of `count` equal columns `e` is, from the start edge (the right one in RTL). */
function columnAt(e: DragEvent<HTMLElement>, el: HTMLElement, count: number): number {
  const rect = el.getBoundingClientRect();
  const x = getComputedStyle(el).direction === "rtl" ? rect.right - e.clientX : e.clientX - rect.left;
  return Math.min(count - 1, Math.max(0, Math.floor(x / (rect.width / count))));
}

function WeekGrid({
  days,
  placed,
  today,
  now,
  timeZone,
  whenOn,
  loaded,
  onDrop,
}: {
  days: number[];
  placed: PlacedItem[];
  today: number;
  now: number;
  timeZone: string;
  whenOn: WhenOn;
  loaded: boolean;
  onDrop: (placed: PlacedItem, drop: CalendarDrop, grabDays: number) => void;
}) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const hours = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<CalendarDrop | null>(null);
  const clock = (minutes: number) => format.dateTime(new Date(minutes * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const first = days[0];
  const allDay = placed.filter(isAllDay);
  const { bars, lanes } = weekBars(allDay, first);
  const timed = placed.filter((p) => !isAllDay(p));
  const nowMinutes = wallClock(now, timeZone).minutes;
  // The hours open at the week's first item or at 7, once the items of a week are in.
  const earliest = timed.filter((p) => p.start >= first && p.start <= first + 6).reduce((min, p) => Math.min(min, p.startMinutes), MORNING);
  const opened = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded || !hours.current || opened.current === first) return;
    opened.current = first;
    hours.current.scrollTop = Math.max((earliest / 60) * HOUR_HEIGHT - 12, 0);
  }, [loaded, first, earliest]);
  const gridColumns = { gridTemplateColumns: "repeat(7, minmax(0, 1fr))" };

  const startDrag = (e: DragEvent<HTMLElement>, p: PlacedItem, grabDays: number) => {
    if (!p.item.moves) return e.preventDefault();
    e.dataTransfer.effectAllowed = "move";
    // On the hours, from where on the block it was picked up, so the block follows the pointer.
    const grabMinutes = isAllDay(p) ? 0 : Math.max(0, ((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR_HEIGHT) * 60);
    setDrag({ placed: p, grabDays, grabMinutes });
  };
  const endDrag = () => {
    setDrag(null);
    setTarget(null);
  };
  const over = (e: DragEvent<HTMLElement>, drop: CalendarDrop | null) => {
    if (!drag || !drop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (target?.day !== drop.day || target.minutes !== drop.minutes) setTarget(drop);
  };
  const dropHere = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (drag && target) onDrop(drag.placed, target, drag.grabDays);
    endDrag();
  };
  /** The time on `day`'s column the dragged block's top is over, snapped. */
  const slotAt = (e: DragEvent<HTMLElement>, day: number): CalendarDrop | null => {
    if (!drag) return null;
    const raw = ((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR_HEIGHT) * 60 - drag.grabMinutes;
    return { day, minutes: Math.min(MINUTES_PER_DAY - SNAP, Math.max(0, Math.round(raw / SNAP) * SNAP)) };
  };
  /** The day of the all-day strip the pointer is over, when the dragged item may become whole days. */
  const stripDayAt = (e: DragEvent<HTMLElement>): CalendarDrop | null =>
    drag?.placed.item.moves?.allDay ? { day: days[columnAt(e, e.currentTarget, 7)], minutes: null } : null;
  // The days the dragged item would cover on the strip.
  const stripGhost =
    drag && target && target.minutes === null
      ? (() => {
          const start = Math.max(target.day - drag.grabDays, first);
          const end = Math.min(target.day - drag.grabDays + (drag.placed.end - drag.placed.start), first + 6);
          return end >= start ? { col: start - first, span: end - start + 1 } : null;
        })()
      : null;
  const ghostMinutes = drag ? (itemMinutes(drag.placed) ?? 30) : 0;

  return (
    <div className="-mx-2 overflow-x-auto px-2">
      <div className="min-w-[42rem] overflow-hidden rounded-lg border border-border">
        <div className="flex border-b border-border bg-bg-subtle">
          <div className="w-14 shrink-0" />
          <div className="grid min-w-0 flex-1" style={gridColumns}>
            {days.map((day) => (
              <div key={day} className="flex items-center gap-1.5 border-s border-border px-2 py-1.5 text-xs text-fg-muted">
                <span className="truncate">{format.dateTime(utcDay(day), { weekday: "short", timeZone: "UTC" })}</span>
                <span
                  className={cn(
                    "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 tabular-nums",
                    day === today ? "bg-accent font-medium text-accent-fg" : "text-fg",
                  )}
                >
                  {utcDay(day).getUTCDate()}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex border-b border-border">
          <div className="w-14 shrink-0 px-1.5 py-1.5 text-end text-[11px] leading-4 text-fg-muted">{t("allDay")}</div>
          <div
            className="relative grid min-h-8 min-w-0 flex-1 py-1"
            style={{ ...gridColumns, gridTemplateRows: `repeat(${Math.max(lanes, 1)}, auto)` }}
            onDragOver={(e) => over(e, stripDayAt(e))}
            onDrop={dropHere}
          >
            {days.map((day, i) => (
              <div key={day} aria-hidden className="border-s border-border" style={{ gridColumn: i + 1, gridRow: `1 / span ${Math.max(lanes, 1)}`, marginBlock: "-0.25rem" }} />
            ))}
            {stripGhost && (
              <div
                aria-hidden
                className={cn("pointer-events-none mx-1 rounded-md border border-dashed", KIND_TINT[drag!.placed.item.kind])}
                style={{ gridColumn: `${stripGhost.col + 1} / span ${stripGhost.span}`, gridRow: `1 / span ${Math.max(lanes, 1)}`, borderColor: "var(--opt-bg)", background: "var(--opt-mark)" }}
              />
            )}
            {bars.map((bar) => (
              <div key={bar.event.item.id} style={{ gridColumn: `${bar.col + 1} / span ${bar.span}`, gridRow: bar.lane + 1 }} className="min-w-0 px-1 pb-0.5">
                <Link
                  href={bar.event.item.href}
                  title={[bar.event.item.title, bar.event.item.detail].filter(Boolean).join(" · ")}
                  draggable={!!bar.event.item.moves}
                  onDragStart={(e) => startDrag(e, bar.event, first + bar.col + columnAt(e, e.currentTarget, bar.span) - bar.event.start)}
                  onDragEnd={endDrag}
                  className={cn(
                    "flex h-6 items-center gap-1.5 truncate rounded-md border-s-2 px-1.5 text-xs font-medium color-mark mark-hover",
                    KIND_TINT[bar.event.item.kind],
                    drag?.placed.item.id === bar.event.item.id && "opacity-40",
                  )}
                  style={{ borderInlineStartColor: "var(--opt-bg)" }}
                >
                  <span className="truncate">{bar.event.item.title.trim() || t("untitled")}</span>
                </Link>
              </div>
            ))}
          </div>
        </div>
        <div ref={hours} className="max-h-[calc(100dvh-16rem)] min-h-[20rem] overflow-y-auto">
          <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
            <div aria-hidden className="relative w-14 shrink-0">
              {Array.from({ length: 23 }, (_, h) => (
                <span key={h} style={{ top: (h + 1) * HOUR_HEIGHT }} className="absolute inset-e-1.5 -translate-y-1/2 text-[11px] tabular-nums text-fg-muted">
                  {format.dateTime(new Date((h + 1) * 3_600_000), { hour: "numeric", timeZone: "UTC" })}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <div
                key={day}
                className={cn("relative min-w-0 flex-1 border-s border-border", day === today && "bg-bg-subtle")}
                onDragOver={(e) => over(e, slotAt(e, day))}
                onDrop={dropHere}
              >
                {Array.from({ length: 23 }, (_, h) => (
                  <div key={h} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ top: (h + 1) * HOUR_HEIGHT }} />
                ))}
                {dayBlocks(timed.filter((p) => p.start === day)).map((b) => {
                  const height = ((b.bottom - b.top) / 60) * HOUR_HEIGHT - 2;
                  const { item } = b.event;
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      title={[item.title, whenOn(b.event, day), item.detail].filter(Boolean).join(" · ")}
                      draggable={!!item.moves}
                      onDragStart={(e) => startDrag(e, b.event, 0)}
                      onDragEnd={endDrag}
                      style={{
                        top: (b.top / 60) * HOUR_HEIGHT + 1,
                        height,
                        insetInlineStart: `calc(${(b.col / b.cols) * 100}% + 2px)`,
                        width: `calc(${100 / b.cols}% - 4px)`,
                        borderInlineStartColor: "var(--opt-bg)",
                      }}
                      className={cn(
                        "absolute flex flex-col overflow-hidden rounded-md border-s-2 px-1.5 py-0.5 text-xs leading-4 color-mark mark-hover",
                        KIND_TINT[item.kind],
                        drag?.placed.item.id === item.id && "opacity-40",
                      )}
                    >
                      <span className="truncate font-medium">{item.title.trim() || t("untitled")}</span>
                      {height >= 30 && <span className="truncate text-[11px] text-fg-muted tabular-nums">{whenOn(b.event, day)}</span>}
                      {height >= 46 && item.detail && <span className="truncate text-[11px] text-fg-muted">{item.detail}</span>}
                    </Link>
                  );
                })}
                {drag && target && target.minutes !== null && target.day === day && (
                  <div
                    aria-hidden
                    className={cn("pointer-events-none absolute inset-x-0.5 z-20 rounded-md border border-dashed px-1.5 py-0.5 text-xs leading-4 tabular-nums", KIND_TINT[drag.placed.item.kind])}
                    style={{
                      top: (target.minutes / 60) * HOUR_HEIGHT + 1,
                      height: (Math.max(ghostMinutes, 30) / 60) * HOUR_HEIGHT - 2,
                      borderColor: "var(--opt-bg)",
                      background: "var(--opt-mark)",
                    }}
                  >
                    {clock(target.minutes)}
                  </div>
                )}
                {day === today && (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}>
                    <span className="-ms-1 h-2 w-2 rounded-full bg-danger" />
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayList({ days, placed, today, whenOn, loaded }: { days: number[]; placed: PlacedItem[]; today: number; whenOn: WhenOn; loaded: boolean }) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const listed = days.map((day) => ({ day, items: placed.filter((p) => p.start <= day && p.end >= day) })).filter((d) => d.items.length > 0);
  const order = (items: PlacedItem[]) => [...items].sort((a, b) => Number(!isAllDay(a)) - Number(!isAllDay(b)) || a.sort - b.sort);
  if (!loaded) return null;
  if (listed.length === 0) return <p className="py-8 text-sm text-fg-muted">{t("emptyWeek")}</p>;
  return (
    <div className="flex max-w-[48rem] flex-col gap-6">
      {listed.map(({ day, items }) => (
        <section key={day} aria-labelledby={`calendar-day-${day}`}>
          <h2 id={`calendar-day-${day}`} className="mb-1 flex items-baseline gap-2 text-sm font-medium text-fg">
            {day === today ? t("today") : day === today + 1 ? t("tomorrow") : format.dateTime(utcDay(day), { weekday: "long", timeZone: "UTC" })}
            <span className="text-xs font-normal text-fg-faint">{format.dateTime(utcDay(day), { day: "numeric", month: "long", timeZone: "UTC" })}</span>
          </h2>
          <ul>
            {order(items).map((p) => {
              const Icon = KIND_ICONS[p.item.kind];
              return (
                <li key={p.item.id}>
                  <Link href={p.item.href} className={cn("flex min-h-10 items-center gap-3 rounded-md px-2 py-2 hover:bg-bg-hover", KIND_TINT[p.item.kind])}>
                    <span className="w-28 shrink-0 text-xs tabular-nums text-fg-muted">{whenOn(p, day)}</span>
                    <span aria-hidden className="w-1 self-stretch rounded-full" style={{ background: "var(--opt-bg)" }} />
                    <Icon className="h-4 w-4 shrink-0 text-fg-icon" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{p.item.title.trim() || t("untitled")}</span>
                      {p.item.detail && <span className="block truncate text-xs text-fg-faint">{p.item.detail}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

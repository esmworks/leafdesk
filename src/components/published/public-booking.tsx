"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { bookingSlotsAction, bookSlotAction, type PublicBookingError } from "@/app/actions/booking";
import { useDurationText } from "@/components/calendar/duration";
import { Button, cn, Input, textareaClass } from "@/components/ui";
import { BOOKING_LIMITS } from "@/lib/booking";
import { browserTimeZone, localDay } from "@/lib/time-zone";
import type { PublicBooking as Booking } from "@/server/booking";

/**
 * A booking link's page (`/b/<token>`, server/booking.ts): the free times, shown on the visitor's
 * own clock (the link's time zone until the browser says theirs), then name, email and a note.
 * It learns nothing of the calendar but which starts are free.
 */
export function PublicBooking({ booking, ticket }: { booking: Booking; ticket: string }) {
  const t = useTranslations("calendar.booking.public");
  const form = useTranslations("form.fill");
  const format = useFormatter();
  const duration = useDurationText();
  // The server and the first render use the link's zone, so hydration matches; then the visitor's.
  const [zone, setZone] = useState(booking.timeZone);
  useEffect(() => setZone(browserTimeZone()), []);
  const [slots, setSlots] = useState(booking.slots);
  const [day, setDay] = useState<number | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [trap, setTrap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PublicBookingError | null>(null);
  const [done, setDone] = useState<{ start: number } | null>(null);

  const days = useMemo(() => {
    const byDay = new Map<number, number[]>();
    for (const start of slots) {
      const d = localDay(start, zone);
      byDay.set(d, [...(byDay.get(d) ?? []), start]);
    }
    return [...byDay.entries()];
  }, [slots, zone]);
  const shownDay = day !== null && days.some(([d]) => d === day) ? day : (days[0]?.[0] ?? null);
  const times = days.find(([d]) => d === shownDay)?.[1] ?? [];
  const clock = (ms: number) => format.dateTime(ms, { hour: "numeric", minute: "2-digit", timeZone: zone });
  const longDay = (ms: number) => format.dateTime(ms, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (slot === null) return;
    setBusy(true);
    setError(null);
    const result = await bookSlotAction(booking.token, { start: slot, name, email, note, ticket, honeypot: trap }).catch(() => ({ ok: false, error: "failed" }) as const);
    setBusy(false);
    if (result.ok) {
      setDone({ start: slot });
      return;
    }
    setError(result.error);
    if (result.error === "slotTaken") {
      // Someone was quicker: the times as they are now, the person's details kept.
      const fresh = await bookingSlotsAction(booking.token).catch(() => null);
      if (fresh) setSlots(fresh);
      setSlot(null);
    }
  };

  const title = <h1 className="page-title text-3xl leading-tight tracking-tight break-words">{booking.title}</h1>;
  const meta = (
    <p className="mt-2 text-sm text-fg-muted">
      {t("with", { name: booking.ownerName })} · {duration(booking.durationMinutes)}
    </p>
  );

  if (done) {
    return (
      <div role="status">
        <h1 className="page-title text-3xl leading-tight tracking-tight">{t("booked")}</h1>
        <p className="mt-3 text-sm text-fg-muted">
          {t("bookedBody", { title: booking.title, owner: booking.ownerName, date: longDay(done.start), time: clock(done.start), email })}
        </p>
      </div>
    );
  }

  return (
    <div>
      {title}
      {meta}
      {booking.description && <p className="mt-4 text-sm whitespace-pre-line text-fg-muted">{booking.description}</p>}
      <p className="mt-4 text-xs text-fg-faint">{t("timeZone", { zone: zone.replaceAll("_", " ") })}</p>

      {slot === null ? (
        days.length === 0 ? (
          <p className="mt-8 rounded-lg border border-border bg-bg-subtle p-5 text-sm text-fg-muted">{t("noSlots")}</p>
        ) : (
          <div className="mt-6">
            <h2 className="text-sm font-medium">{t("chooseDay")}</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {days.map(([d, list]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={d === shownDay}
                  onClick={() => setDay(d)}
                  className={cn(
                    "flex min-w-16 flex-col items-center rounded-md border px-3 py-1.5 text-sm hover:bg-bg-hover",
                    d === shownDay ? "border-accent bg-bg-hover" : "border-border",
                  )}
                >
                  <span className="text-xs text-fg-muted">{format.dateTime(list[0], { weekday: "short", timeZone: zone })}</span>
                  <span className="font-medium tabular-nums">{format.dateTime(list[0], { day: "numeric", month: "short", timeZone: zone })}</span>
                </button>
              ))}
            </div>
            <h2 className="mt-6 text-sm font-medium">{t("chooseTime")}</h2>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {times.map((start) => (
                <button
                  key={start}
                  type="button"
                  onClick={() => {
                    setSlot(start);
                    setError(null);
                  }}
                  className="h-9 rounded-md border border-border text-sm tabular-nums hover:border-accent hover:bg-bg-hover"
                >
                  {clock(start)}
                </button>
              ))}
            </div>
            {error === "slotTaken" && (
              <p role="alert" className="mt-4 text-sm text-danger">
                {t("errors.slotTaken")}
              </p>
            )}
          </div>
        )
      ) : (
        <form onSubmit={submit} className="relative mt-6 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3">
            <p className="text-sm font-medium">
              {longDay(slot)}, {clock(slot)}
            </p>
            <button type="button" onClick={() => setSlot(null)} className="shrink-0 text-sm text-fg-muted underline decoration-border underline-offset-4 hover:text-fg">
              {t("change")}
            </button>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t("name")}</span>
            <Input required maxLength={BOOKING_LIMITS.name} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t("email")}</span>
            <Input type="email" required maxLength={BOOKING_LIMITS.email} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t("note")}</span>
            <textarea className={textareaClass} rows={3} maxLength={BOOKING_LIMITS.note} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {/* People never see or reach this field; bots that fill in every input do (as on public forms). */}
          <div aria-hidden className="pointer-events-none absolute -inset-s-[10000px] h-px w-px overflow-hidden">
            <label>
              {form("honeypot")}
              <input
                type="text"
                name="leave_empty"
                tabIndex={-1}
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                value={trap}
                onChange={(e) => setTrap(e.target.value)}
              />
            </label>
          </div>
          {error && error !== "slotTaken" && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${error}`)}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              {t("confirm")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

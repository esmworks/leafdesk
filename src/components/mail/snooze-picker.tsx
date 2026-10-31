"use client";

import { CalendarClock, Clock, Moon, Sun } from "lucide-react";
import { useFormatter, useTimeZone, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { DatePhraseInput } from "@/components/date-phrase-input";
import { MenuItem, MenuSeparator, Popover } from "@/components/ui";
import { snoozeChoices, snoozeMoment, type SnoozeChoice } from "@/lib/mail-snooze";
import { browserTimeZone } from "@/lib/time-zone";

const ICONS: Record<SnoozeChoice["key"], typeof Clock> = { laterToday: Moon, tomorrow: Sun, weekend: CalendarClock, nextWeek: CalendarClock };

/**
 * Until when a conversation is snoozed: this evening, tomorrow, the weekend, next week, or a
 * moment typed in words ("fri 9am", "nov 12"; a day alone means its morning). Opened by the
 * thread's and the selection's Snooze buttons, the right-click menu and the b key, from the button
 * or the point it was asked from. Loaded the first time it opens.
 */
export function SnoozePicker({ at, onPick, onClose }: { at: { x: number; y: number } | Element; onPick: (until: Date) => void; onClose: () => void }) {
  const t = useTranslations("mail.snooze");
  const format = useFormatter();
  const timeZone = useTimeZone() ?? browserTimeZone();
  const [now] = useState(() => Date.now());
  const choices = useMemo(() => snoozeChoices(now, timeZone), [now, timeZone]);
  const [wrong, setWrong] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const pick = (until: number) => {
    onClose();
    onPick(new Date(until));
  };
  const when = (instant: number) => format.dateTime(new Date(instant), { weekday: "short", hour: "numeric", minute: "2-digit", timeZone });

  return (
    <Popover at={at} align="end" open onOpenChange={(open) => !open && onClose()} className="w-72" trigger={() => null}>
      <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("title")}</div>
      {choices.map(({ key, at: until }) => {
        const Icon = ICONS[key];
        return (
          <MenuItem key={key} icon={<Icon className="h-4 w-4" />} trailing={<span className="text-xs text-fg-muted tabular-nums">{when(until)}</span>} onClick={() => pick(until)}>
            {t(key)}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <DatePhraseInput
        ref={input}
        label={t("pick")}
        placeholder={t("placeholder")}
        className="px-1 pb-1"
        onPick={(found) => {
          const until = snoozeMoment(found, Date.now(), timeZone);
          if (until === null) return setWrong(true);
          pick(until);
        }}
        onDone={onClose}
      />
      {wrong && <p className="px-2 pb-1 text-xs text-danger">{t("notAhead")}</p>}
    </Popover>
  );
}

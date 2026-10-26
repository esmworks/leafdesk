"use client";

import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { forwardRef, useId, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/ui";
import type { DatePhrase, DatePhraseContext } from "@/lib/date-phrase";
import { browserTimeZone, dayNumber } from "@/lib/time-zone";

type Parse = typeof import("@/lib/date-phrase").parseDatePhrase;

// The grammar loads when someone first types into a box, not with the page.
let parser: Parse | null = null;
let loading: Promise<Parse> | null = null;
const loadParser = () => (loading ??= import("@/lib/date-phrase").then((m) => (parser = m.parseDatePhrase)));

/** A day or moment as the box says what it found: "Fri, Oct 16, 2026" or "Fri, Oct 16, 2026, 5:00 PM". */
function describe(found: DatePhrase, time: boolean, locale: string, timeZone: string): string {
  const options = { weekday: "short", year: "numeric", month: "short", day: "numeric" } as const;
  if (found.kind === "moment" && time) {
    return new Intl.DateTimeFormat(locale, { ...options, hour: "numeric", minute: "2-digit", timeZone }).format(new Date(found.at));
  }
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(dayNumber(found.day) * 86_400_000));
}

/**
 * A box for a date written as a phrase (lib/date-phrase): "fri 5pm", "aug 31", "in 2w", "+3d". As
 * it is typed it says what the phrase names; Enter hands that to `onPick` and empties the box.
 * `time` false: the place holds days only, so a moment shows (and is used) as its day.
 */
export const DatePhraseInput = forwardRef<
  HTMLInputElement,
  {
    onPick: (found: DatePhrase) => void;
    /** Enter in the empty box, as in the fields beside it (closing a picker). */
    onDone?: () => void;
    /** The day "+2w" and "-3d" count from: the one the picker shows. */
    reference?: string | null;
    order?: DatePhraseContext["order"];
    time?: boolean;
    label?: string;
    placeholder?: string;
    className?: string;
    inputClassName?: string;
  }
>(function DatePhraseInput({ onPick, onDone, reference, order, time = true, label, placeholder, className, inputClassName }, ref) {
  const t = useTranslations("common.datePhrase");
  const locale = useLocale();
  const timeZone = useTimeZone() ?? browserTimeZone();
  const [text, setText] = useState("");
  const [parse, setParse] = useState<Parse | null>(() => parser);
  const hint = useId();
  const typed = text.trim();
  const found = parse && typed ? parse(typed, { locale, timeZone, reference, order }) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (!typed) return onDone?.();
    e.preventDefault();
    const take = (read: DatePhrase | null) => {
      if (!read) return;
      onPick(read);
      setText("");
    };
    // Typed and entered before the grammar came: read it once it has.
    if (parse) take(found);
    else void loadParser().then((loaded) => take(loaded(typed, { locale, timeZone, reference, order })));
  };

  return (
    <div className={className}>
      <input
        ref={ref}
        type="text"
        value={text}
        aria-label={label ?? t("label")}
        aria-describedby={typed ? hint : undefined}
        placeholder={placeholder ?? t("placeholder")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!parse) void loadParser().then((loaded) => setParse(() => loaded));
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "h-8 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent",
          inputClassName,
        )}
      />
      {typed && parse && (
        <p id={hint} aria-live="polite" className={cn("mt-1 px-0.5 text-xs", found ? "text-fg-muted" : "text-danger")}>
          {found ? t("preview", { when: describe(found, time, locale, timeZone) }) : t("unreadable")}
        </p>
      )}
    </div>
  );
});

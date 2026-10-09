"use client";

import { CalendarDays, Tag, User, X } from "lucide-react";
import { useFormatter, useLocale, useTimeZone, useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { parseQuickAdd, type QuickAddMatch, type QuickAddOption, type QuickAddResult } from "@/lib/quick-add";
import { dayString, localDay } from "@/lib/time-zone";
import { usePeople } from "./person-cell";
import { usePropertyAccess } from "./property-access";
import { TITLE, type Property, type View } from "./types";
import type { DatabaseApi } from "./use-database";

const OPTION_TYPES = new Set<Property["type"]>(["select", "status", "multi_select"]);

/**
 * Quick add for a view's new rows (see lib/quick-add): the title typed for a new row gives its date
 * (the view's date property, else the first one), its people (the first person property) and its
 * options; what's recognised shows under the title field, and a part the person chooses to keep
 * stays in the title. One new row is named at a time, so what was kept is held here.
 */
export function useQuickAdd(api: DatabaseApi, view: View, properties: Property[]) {
  const locale = useLocale();
  const timeZone = useTimeZone() ?? "UTC";
  const { people } = usePeople();
  const access = usePropertyAccess();
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const kept = useRef(ignored);
  kept.current = ignored;

  const targets = useMemo(() => {
    const editable = properties.filter((p) => access.canEditValues(p.id));
    const dates = editable.filter((p) => p.type === "date");
    const options: QuickAddOption[] = editable
      .filter((p) => OPTION_TYPES.has(p.type))
      .flatMap((p) => (p.options.options ?? []).map((o) => ({ propertyId: p.id, optionId: o.id, name: o.name })));
    return {
      date: dates.find((p) => p.id === view.config.dateBy) ?? dates[0],
      person: editable.find((p) => p.type === "person"),
      options,
      multi: new Set(editable.filter((p) => p.type === "multi_select").map((p) => p.id)),
    };
  }, [properties, access, view.config.dateBy]);

  const parse = useCallback(
    (text: string, keep: ReadonlySet<string> = kept.current): QuickAddResult =>
      parseQuickAdd(text, {
        locale,
        today: dayString(localDay(Date.now(), timeZone)),
        people: targets.person ? people.filter((p) => p.active) : [],
        options: targets.options,
        ignored: keep,
        dates: Boolean(targets.date),
      }),
    [locale, timeZone, people, targets],
  );

  /** Names the new row `text`: the title without the recognised parts, and their values set. */
  const save = useCallback(
    (rowId: string, text: string) => {
      const result = parse(text);
      setIgnored(new Set());
      const values: Record<string, unknown> = {};
      if (result.date && targets.date) values[targets.date.id] = result.date;
      if (result.people.length && targets.person) values[targets.person.id] = result.people;
      for (const option of result.options) {
        if (!targets.multi.has(option.propertyId)) values[option.propertyId] = option.optionId;
        else values[option.propertyId] = [...((values[option.propertyId] as string[] | undefined) ?? []), option.optionId];
      }
      void api.setCell(rowId, TITLE, result.title);
      void api.setRowValues(rowId, values);
    },
    [api, parse, targets],
  );

  return useMemo(
    () => ({
      parse,
      save,
      /** Keeps a recognised part (as written) in the title. */
      keep: (text: string) => setIgnored((old) => new Set(old).add(text)),
    }),
    [parse, save],
  );
}

export type QuickAdd = ReturnType<typeof useQuickAdd>;

const ICONS = { date: CalendarDays, person: User, option: Tag } as const;

/** What quick add recognises in `text`, under a new row's title field; each part can be kept in the title. */
export function QuickAddParts({ quick, text }: { quick: QuickAdd; text: string }) {
  const t = useTranslations("database.quickAdd");
  const format = useFormatter();
  const result = quick.parse(text);
  if (!result.matches.length) return null;
  const label = (match: QuickAddMatch) =>
    match.kind === "date" && result.date
      ? `${match.text} · ${format.dateTime(new Date(`${result.date}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}`
      : match.text;
  return (
    <div
      role="group"
      aria-label={t("recognised")}
      // Clicking a part mustn't take the focus from the title field (which would save it).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      className="mt-1.5 flex flex-wrap gap-1"
    >
      {result.matches.map((match) => {
        const Icon = ICONS[match.kind];
        return (
          <span
            key={`${match.start}-${match.text}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-bg-hover px-1.5 py-0.5 text-xs text-fg-muted"
          >
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{label(match)}</span>
            <button
              type="button"
              aria-label={t("keep", { text: match.text })}
              title={t("keep", { text: match.text })}
              onClick={() => quick.keep(match.text)}
              className="-mr-0.5 rounded text-fg-faint hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

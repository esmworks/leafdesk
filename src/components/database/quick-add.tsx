"use client";

import { CalendarDays, Tag, User, X } from "lucide-react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatIsoDate } from "@/lib/mentions";
import { parseQuickAdd, type QuickAddMatch, type QuickAddOption, type QuickAddResult } from "@/lib/quick-add";
import { dayString, localDay } from "@/lib/time-zone";
import { viewDateProperty } from "@/lib/views";
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

  const targets = useMemo(() => {
    const editable = properties.filter((p) => access.canEditValues(p.id));
    const options: QuickAddOption[] = editable
      .filter((p) => OPTION_TYPES.has(p.type))
      .flatMap((p) => (p.options.options ?? []).map((o) => ({ propertyId: p.id, optionId: o.id, name: o.name })));
    return {
      date: viewDateProperty(view.config, editable),
      person: editable.find((p) => p.type === "person"),
      options,
      multi: new Set(editable.filter((p) => p.type === "multi_select").map((p) => p.id)),
    };
  }, [properties, access, view.config]);

  const active = useMemo(() => people.filter((p) => p.active), [people]);

  const parse = useCallback(
    (text: string): QuickAddResult =>
      parseQuickAdd(text, {
        locale,
        today: dayString(localDay(Date.now(), timeZone)),
        people: targets.person ? active : [],
        options: targets.options,
        ignored,
        dates: Boolean(targets.date),
      }),
    [locale, timeZone, active, targets, ignored],
  );

  /** Forgets the parts kept in the title: each new row's title starts without any. */
  const reset = useCallback(() => setIgnored(new Set()), []);

  /** Names the new row `text`: the title without the recognised parts, and their values set. */
  const save = useCallback(
    (rowId: string, text: string) => {
      const result = parse(text);
      reset();
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
    [api, parse, reset, targets],
  );

  return useMemo(
    () => ({
      parse,
      save,
      reset,
      /** Keeps a recognised part (as written) in the title. */
      keep: (text: string) => setIgnored((old) => new Set(old).add(text)),
    }),
    [parse, save, reset],
  );
}

export type QuickAdd = ReturnType<typeof useQuickAdd>;

const ICONS = { date: CalendarDays, person: User, option: Tag } as const;

/** What quick add recognises in `text`, under a new row's title field; each part can be kept in the title. */
export function QuickAddParts({ quick, text }: { quick: QuickAdd; text: string }) {
  const t = useTranslations("database.quickAdd");
  const locale = useLocale();
  // A title field that opens or closes without saving leaves nothing kept for the next one.
  const { reset } = quick;
  useEffect(() => {
    reset();
    return reset;
  }, [reset]);
  const result = quick.parse(text);
  if (!result.matches.length) return null;
  const label = (match: QuickAddMatch) =>
    match.kind === "date" && result.date
      ? `${match.text} · ${formatIsoDate(result.date, locale)}`
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

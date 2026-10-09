"use client";

import { CalendarDays, Tag, User, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui";
import { formatIsoDate } from "@/lib/mentions";
import { parseQuickAdd, type QuickAddMatch, type QuickAddOption, type QuickAddResult } from "@/lib/quick-add";
import { viewDateProperty } from "@/lib/views";
import { usePeople } from "./person-cell";
import { usePropertyAccess } from "./property-access";
import { TITLE, type Property, type View } from "./types";
import type { DatabaseApi } from "./use-database";
import { useToday } from "./use-today";

const OPTION_TYPES = new Set<Property["type"]>(["select", "status", "multi_select"]);

/**
 * Quick add for a view's new rows (see lib/quick-add): the title typed for a new row gives its date
 * (the view's date property, else the first one), its people (the first person property) and its
 * options; what's recognised shows under the title field, and a part the person chooses to keep
 * stays in the title. One new row is named at a time, so what was kept is held here.
 */
export function useQuickAdd(api: DatabaseApi, view: View, properties: Property[]) {
  const locale = useLocale();
  const today = useToday();
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
        today,
        people: targets.person ? active : [],
        options: targets.options,
        ignored,
        dates: Boolean(targets.date),
      }),
    [locale, today, active, targets, ignored],
  );

  /** Forgets the parts kept in the title: each new row's title starts without any. */
  const reset = useCallback(() => setIgnored(new Set()), []);

  /** Names the new row `text`: the title without the recognised parts, and their values set. */
  const save = useCallback(
    (rowId: string, text: string) => {
      const result = parse(text);
      reset();
      const values: Record<string, unknown> = { [TITLE]: result.title };
      if (result.date && targets.date) values[targets.date.id] = result.date;
      if (result.people.length && targets.person) values[targets.person.id] = result.people;
      for (const option of result.options) {
        if (!targets.multi.has(option.propertyId)) values[option.propertyId] = option.optionId;
        else values[option.propertyId] = [...((values[option.propertyId] as string[] | undefined) ?? []), option.optionId];
      }
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

/**
 * The quick add of a view's new rows (see useNewRow), for the title editor of the one being named:
 * card views provide it around their cards, the table around the new row's title cell.
 */
export const QuickAddContext = createContext<QuickAdd | null>(null);

const ICONS = { date: CalendarDays, person: User, option: Tag } as const;

/**
 * What quick add recognises in `text`, under a new row's title field (`floating` over what follows
 * it); each part can be kept in the title.
 */
export function QuickAddParts({ quick, text, floating }: { quick: QuickAdd; text: string; floating?: boolean }) {
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
      className={cn(
        "mt-1.5 flex flex-wrap gap-1",
        floating && "absolute top-full left-0 z-20 w-max max-w-72 rounded-md border border-border bg-bg p-1 shadow-md",
      )}
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

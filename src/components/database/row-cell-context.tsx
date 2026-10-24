"use client";

import { CalendarClock, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";

/**
 * The row whose values a row page shows (components/database/row-properties.tsx): which row, and
 * whether it is one of its database's row templates, whose person and date values may say "me",
 * "today" or "now" (lib/template-values). Views and cards have none.
 */
export type RowCellContextValue = { rowId: string; template: boolean };

const RowCellContext = createContext<RowCellContextValue | null>(null);

export const RowCellProvider = RowCellContext.Provider;

export const useRowCell = () => useContext(RowCellContext);

/** A template's "Me", "Today" or "Now": filled in when a row is added from it. */
export function MarkerChip({ marker }: { marker: "me" | "today" | "now" }) {
  const t = useTranslations("database.templateValues");
  const Icon = marker === "me" ? UserRound : CalendarClock;
  return (
    <span
      title={t("hint")}
      className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[0.92em] leading-tight font-medium text-accent"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{t(marker)}</span>
    </span>
  );
}

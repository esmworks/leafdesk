"use client";

import { Repeat } from "lucide-react";
import { createContext, useContext } from "react";
import { lazyPart } from "@/components/lazy-part";
import type { RowRepeatView } from "@/lib/row-repeat";
import type { Property } from "./types";

/**
 * Rows that come round again (server/row-repeat.ts) as views and row pages show them: the rules
 * of the rows there, given by the database page (its snapshot's `repeats`) or a row page (the
 * row's `repeat`). Date cells of a row with a rule on them show ↻, and their editor a Repeat row.
 * Only this context and the wrappers are in a page's first load; what they show is
 * `repeat-parts.tsx`, loaded the first time a rule or a Repeat row shows.
 */
export type RowRepeatsValue = {
  repeats: Record<string, RowRepeatView>;
  /** Rows here may be set to repeat: the database marks rows done, isn't synced and isn't a template. */
  repeatable: boolean;
  /** Reads the rows again after a rule changed. */
  reload: () => void;
};

const RowRepeatsContext = createContext<RowRepeatsValue | null>(null);

export const RowRepeatsProvider = RowRepeatsContext.Provider;

export const useRowRepeats = () => useContext(RowRepeatsContext);

const RepeatMarkPart = lazyPart(
  () => import("./repeat-parts").then((m) => m.RepeatMarkPart),
  <span className="ms-1 inline-flex shrink-0 text-fg-faint">
    <Repeat className="h-3 w-3" aria-hidden />
  </span>,
);
const RepeatRowPart = lazyPart(
  () => import("./repeat-parts").then((m) => m.RepeatRowPart),
  <div className="h-6" />,
);

/** ↻ beside a date that comes round again. */
export function RepeatMark({ rowId, propertyId }: { rowId: string; propertyId: string }) {
  const repeat = useRowRepeats()?.repeats[rowId];
  if (!repeat || repeat.propertyId !== propertyId) return null;
  return <RepeatMarkPart repeat={repeat} />;
}

/** The Repeat row of a date's editor, where rows may repeat. */
export function RepeatRow(props: { rowId: string; propertyId: string; value: unknown }) {
  if (!useRowRepeats()?.repeatable) return null;
  return <RepeatRowPart {...props} />;
}

/**
 * The note a write marking a repeating row done shows (where its copy goes), worked out in
 * `repeat-parts.tsx`, loaded only then; resolves to null for any other write.
 */
export function repeatNote(
  locale: string,
  repeat: RowRepeatView | undefined,
  properties: Pick<Property, "id" | "type" | "options">[],
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
) {
  if (!repeat) return Promise.resolve(null);
  return import("./repeat-parts").then((m) => m.nextRepeatNote(locale, repeat, properties, before, changes));
}

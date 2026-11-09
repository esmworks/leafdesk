import type { CSSProperties } from "react";
import type { CalendarItemKind } from "@/lib/calendar-items";

/**
 * Each source's color (globals.css `.tint-*`): synced events blue, meeting notes purple, tasks green,
 * reminders orange. Time planned for a task is green too, drawn outlined (BLOCK_LOOK) rather than filled.
 */
export const KIND_TINT: Record<CalendarItemKind, string> = {
  event: "tint-blue",
  meeting: "tint-purple",
  task: "tint-green",
  reminder: "tint-orange",
  block: "tint-green",
};

/**
 * How planned time is drawn: a dashed edge, apart from a task's filled green, over the palette's
 * lightest green (BLOCK_FILL, a class so a hover can still change it).
 */
export const BLOCK_FILL = "bg-(--opt-tint)";
export const BLOCK_LOOK: CSSProperties = {
  borderColor: "color-mix(in srgb, var(--opt-bg) 70%, var(--opt-fg))",
  borderStyle: "dashed",
};

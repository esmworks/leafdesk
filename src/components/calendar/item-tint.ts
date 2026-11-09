import type { CalendarItemKind } from "@/lib/calendar-items";

/** Each source's color (globals.css `.tint-*`): synced events blue, meeting notes purple, tasks green, reminders orange. */
export const KIND_TINT: Record<CalendarItemKind, string> = {
  event: "tint-blue",
  meeting: "tint-purple",
  task: "tint-green",
  reminder: "tint-orange",
};

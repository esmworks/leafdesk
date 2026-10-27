import type { PropertyType, ViewConfig, ViewType } from "@/db/schema/app";
import { chartGroupProperty } from "./chart";
import { ROW_VIEW_TYPES } from "./views";

/**
 * The layouts a view can be switched between once it exists: those that show rows. Forms,
 * dashboards and charts keep their own kind of settings, so they stay what they were made as.
 */
export const SWITCHABLE_VIEW_TYPES: readonly ViewType[] = ROW_VIEW_TYPES;

export function canSwitchLayout(from: ViewType, to: ViewType): boolean {
  return SWITCHABLE_VIEW_TYPES.includes(from) && SWITCHABLE_VIEW_TYPES.includes(to);
}

/**
 * What a view of `type` is placed by, from the properties it may use, for the settings `config`
 * doesn't have yet: a board's grouping, a calendar's or timeline's date, a map's place, a chart's
 * groups, a pivot's rows and columns (the first date across, by month). A new view starts with these, and a view switched to another layout gets them, keeping
 * whatever it already says.
 */
export function layoutDefaults(type: ViewType, properties: readonly { id: string; type: PropertyType }[], config: ViewConfig): ViewConfig {
  const first = (...types: PropertyType[]) => properties.find((p) => types.includes(p.type))?.id;
  if (type === "board" && !config.groupBy) return { groupBy: first("select", "status") };
  if ((type === "calendar" || type === "timeline") && !config.dateBy) return { dateBy: first("date") };
  if (type === "map" && !config.placeBy) return { placeBy: first("place") };
  if (type === "chart" && !config.groupBy) return { groupBy: chartGroupProperty([...properties], {})?.id };
  if (type === "pivot" && !config.groupBy) {
    const groupBy = chartGroupProperty([...properties], {})?.id;
    const columnBy = first("date");
    return { groupBy, ...(columnBy ? { columnBy } : {}) };
  }
  return {};
}

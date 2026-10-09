"use client";

import { useTimeZone } from "next-intl";
import { dayString, localDay } from "@/lib/time-zone";

/** The viewer's time zone (the browser's, see TimeZoneCookie), the one pages are rendered in too. */
export function useViewerTimeZone() {
  return useTimeZone() ?? "UTC";
}

/**
 * Today as YYYY-MM-DD in the viewer's time zone: what views, quick add and relative dates count
 * from, and what created and edited times are placed by (see useGroupContext, the timeline).
 */
export function useToday() {
  return dayString(localDay(Date.now(), useViewerTimeZone()));
}

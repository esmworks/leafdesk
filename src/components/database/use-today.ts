"use client";

import { useTimeZone } from "next-intl";
import { dayString, localDay } from "@/lib/time-zone";

/**
 * Today as YYYY-MM-DD in the viewer's time zone, the one pages are rendered in too: what views,
 * quick add and relative dates count from.
 */
export function useToday() {
  const timeZone = useTimeZone() ?? "UTC";
  return dayString(localDay(Date.now(), timeZone));
}

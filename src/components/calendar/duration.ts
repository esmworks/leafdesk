"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { hoursAndMinutes } from "@/lib/work-blocks";

/** "2 h 30 min" for a number of minutes, in the Calendar's words. */
export function useDurationText() {
  const t = useTranslations("calendar");
  return useCallback(
    (total: number) => {
      const { hours, minutes } = hoursAndMinutes(total);
      if (!hours) return t("durationMinutes", { minutes });
      return minutes ? t("durationBoth", { hours, minutes }) : t("durationHours", { hours });
    },
    [t],
  );
}

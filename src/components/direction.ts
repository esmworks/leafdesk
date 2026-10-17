import { useLocale } from "next-intl";
import { isLocale, localeDirection } from "@/i18n/config";

/**
 * Writing direction for code that works with screen coordinates. Layout follows `<html dir>` on its
 * own (logical classes); pointer positions and measured rectangles don't, so drags, resizes and
 * popovers placed by hand ask here which way the line runs.
 */

/** Whether `el` (the page when left out) runs right to left. */
export function isRtl(el?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  return getComputedStyle(el ?? document.documentElement).direction === "rtl";
}

/**
 * +1 when the line runs left to right, -1 when it runs right to left: a pointer's x movement times
 * this is its movement towards the end of the line (what makes a sidebar or column wider).
 */
export function inlineSign(el?: Element | null): 1 | -1 {
  return isRtl(el) ? -1 : 1;
}

/** The interface language's direction, for rendering (labels that name a side, menu placements). */
export function useDirection(): "ltr" | "rtl" {
  const locale = useLocale();
  return isLocale(locale) ? localeDirection(locale) : "ltr";
}

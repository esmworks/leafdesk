import type { NumberDisplay, NumberFormat } from "@/db/schema/app";
import { isPercent } from "./number-format";
import { SELECT_COLORS } from "./properties";

/**
 * Number properties shown as a bar or a ring instead of a plain number: how full it is, the value
 * divided by `divideBy`, in one of the option colors (the accent color without one). Only how values
 * show; stored values, sorting and calculations don't change. Pure and client-safe.
 */

export type { NumberDisplay };

/** How a number shows: the plain number, or "bar" and "ring" (as rollup percentages do). */
export const NUMBER_DISPLAYS = ["number", "bar", "ring"] as const;
export type NumberDisplayKind = (typeof NUMBER_DISPLAYS)[number];
export type NumberDisplayColor = (typeof SELECT_COLORS)[number];

/**
 * What a full bar stands for when `divideBy` isn't set: 100, or 100 % (stored as 1) for a percent
 * property.
 */
export function defaultDivideBy(format: NumberFormat | null | undefined) {
  return isPercent(format) ? 1 : 100;
}

/** How full a value's bar or ring is, from 0 to 1. */
export function numberShare(value: number, display: NumberDisplay, format?: NumberFormat | null) {
  const divideBy = display.divideBy ?? defaultDivideBy(format);
  if (!Number.isFinite(value) || !(divideBy > 0)) return 0;
  return Math.min(1, Math.max(0, value / divideBy));
}

/**
 * Checks a number display given by the app. null or "number" is the plain number (`null`, nothing
 * to store). Returns the display as stored, or what is wrong.
 */
export function checkNumberDisplay(input: unknown): { ok: true; display: NumberDisplay | null } | { ok: false; message: string } {
  if (input === null || input === undefined) return { ok: true, display: null };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "A number display is an object {display, color, divideBy}" };
  const { display, color, divideBy } = input as Record<string, unknown>;
  if (!(NUMBER_DISPLAYS as readonly unknown[]).includes(display)) {
    return { ok: false, message: `Number display must be one of: ${NUMBER_DISPLAYS.join(", ")}` };
  }
  if (display === "number") return { ok: true, display: null };
  if (color !== undefined && color !== null && !(SELECT_COLORS as readonly unknown[]).includes(color)) {
    return { ok: false, message: `Color must be one of: ${SELECT_COLORS.join(", ")}` };
  }
  if (divideBy !== undefined && divideBy !== null && !(typeof divideBy === "number" && Number.isFinite(divideBy) && divideBy > 0)) {
    return { ok: false, message: "Divide by must be a number greater than 0" };
  }
  return {
    ok: true,
    display: {
      display: display as "bar" | "ring",
      ...(typeof color === "string" ? { color: color as NumberDisplayColor } : {}),
      ...(typeof divideBy === "number" ? { divideBy } : {}),
    },
  };
}

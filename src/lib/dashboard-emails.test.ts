import { describe, expect, it } from "vitest";
import { defaultSubscriptionPeriod, emailPeriod, isSubscriptionPeriod, readDashboardEmailTarget, sameTarget } from "./dashboard-emails";
import { periodRange, previousRange } from "./dashboard-period";
import { nextOccurrence, type RepeatRule } from "./schedule";

describe("defaultSubscriptionPeriod", () => {
  it("starts with the whole period that just ended when the email goes out", () => {
    expect(defaultSubscriptionPeriod("daily")).toBe("yesterday");
    expect(defaultSubscriptionPeriod("weekly")).toBe("last_week");
    expect(defaultSubscriptionPeriod("monthly")).toBe("last_month");
    expect(defaultSubscriptionPeriod("yearly")).toBe("last_year");
  });

  it("offers only known periods", () => {
    expect(isSubscriptionPeriod("last_week")).toBe(true);
    expect(isSubscriptionPeriod("dashboard")).toBe(true);
    expect(isSubscriptionPeriod("last_7_days")).toBe(false);
    expect(isSubscriptionPeriod(null)).toBe(false);
  });
});

describe("emailPeriod", () => {
  it("counts yesterday in the schedule's time zone", () => {
    // 22:30 UTC on Sunday is already Monday 01:30 in Istanbul, and still Sunday in New York.
    const at = new Date("2026-10-25T22:30:00Z");
    expect(emailPeriod("yesterday", "", at, "Europe/Istanbul")).toEqual({ kind: "custom", start: "2026-10-25", end: "2026-10-25" });
    expect(emailPeriod("yesterday", "", at, "America/New_York")).toEqual({ kind: "custom", start: "2026-10-24", end: "2026-10-24" });
  });

  it("compares yesterday with the day before it", () => {
    const period = emailPeriod("yesterday", "", new Date("2026-10-26T05:00:00Z"), "Europe/Istanbul");
    expect(previousRange(period, new Date("2026-10-26T05:00:00Z"), "Europe/Istanbul")).toEqual({ start: "2026-10-24", end: "2026-10-24" });
  });

  it("takes the dashboard's own period, or all time when it has none", () => {
    const at = new Date("2026-10-26T05:00:00Z");
    expect(emailPeriod("dashboard", "this_month", at, "UTC")).toEqual({ kind: "this_month" });
    expect(emailPeriod("dashboard", "2026-01-01/2026-03-31", at, "UTC")).toEqual({ kind: "custom", start: "2026-01-01", end: "2026-03-31" });
    expect(emailPeriod("dashboard", "", at, "UTC")).toEqual({ kind: "all" });
    expect(emailPeriod("dashboard", "nonsense", at, "UTC")).toEqual({ kind: "all" });
  });

  it("gives a Monday 08:00 email last week, beside the week before", () => {
    const rule: RepeatRule = { frequency: "weekly", interval: 1, weekdays: [1], time: "08:00", start: "2026-10-01" };
    const timeZone = "Europe/Istanbul";
    const at = nextOccurrence(rule, timeZone, new Date("2026-10-22T12:00:00Z"));
    expect(at.toISOString()).toBe("2026-10-26T05:00:00.000Z");
    const period = emailPeriod("last_week", "", at, timeZone);
    expect(period).toEqual({ kind: "last_week" });
    expect(periodRange(period, at, timeZone)).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(previousRange(period, at, timeZone)).toEqual({ start: "2026-10-12", end: "2026-10-18" });
  });

  it("gives a monthly email on the 1st the month before", () => {
    const at = new Date("2026-11-01T06:00:00Z");
    const period = emailPeriod("last_month", "", at, "Europe/Berlin");
    expect(periodRange(period, at, "Europe/Berlin")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(previousRange(period, at, "Europe/Berlin")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
});

describe("readDashboardEmailTarget", () => {
  it("reads a block or a view, never both", () => {
    expect(readDashboardEmailTarget({ block: "b-1" })).toEqual({ block: "b-1" });
    expect(readDashboardEmailTarget({ view: "v_2" })).toEqual({ view: "v_2" });
    expect(readDashboardEmailTarget({ block: "b", view: "v" })).toBeNull();
    expect(readDashboardEmailTarget({ block: "" })).toBeNull();
    expect(readDashboardEmailTarget({ block: "a/b" })).toBeNull();
    expect(readDashboardEmailTarget({ view: 3 })).toBeNull();
    expect(readDashboardEmailTarget(["block"])).toBeNull();
    expect(readDashboardEmailTarget(null)).toBeNull();
  });

  it("tells a block from a view with the same id", () => {
    expect(sameTarget({ block: "x" }, { block: "x" })).toBe(true);
    expect(sameTarget({ block: "x" }, { view: "x" })).toBe(false);
    expect(sameTarget({ view: "x" }, { view: "y" })).toBe(false);
  });
});

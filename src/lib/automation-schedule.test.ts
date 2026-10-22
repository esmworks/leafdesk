import { describe, expect, it } from "vitest";
import { nextScheduledRun, parseAutomationSchedule, parseCron } from "./automation-schedule";

const next = (schedule: Parameters<typeof nextScheduledRun>[0], zone: string, after: string) => nextScheduledRun(schedule, zone, new Date(after))?.toISOString() ?? null;

describe("parseAutomationSchedule", () => {
  it("takes valid schedules and normalizes lists", () => {
    expect(parseAutomationSchedule({ frequency: "daily", time: "09:00" })).toEqual({ frequency: "daily", time: "09:00" });
    expect(parseAutomationSchedule({ frequency: "weekly", time: "09:00", weekdays: [5, 1, 1] })).toEqual({ frequency: "weekly", time: "09:00", weekdays: [1, 5] });
    expect(parseAutomationSchedule({ frequency: "cron", cron: "  0  9 * * 1-5 " })).toEqual({ frequency: "cron", cron: "0 9 * * 1-5" });
  });
  it("refuses invalid ones", () => {
    expect(parseAutomationSchedule({ frequency: "daily", time: "24:00" })).toBeNull();
    expect(parseAutomationSchedule({ frequency: "weekly", time: "09:00", weekdays: [] })).toBeNull();
    expect(parseAutomationSchedule({ frequency: "monthly", time: "09:00", days: [0] })).toBeNull();
    expect(parseAutomationSchedule({ frequency: "cron", cron: "0 9 * *" })).toBeNull();
    expect(parseAutomationSchedule({ frequency: "hourly", time: "09:00" })).toBeNull();
  });
});

describe("parseCron", () => {
  it("reads names, ranges, steps and Sunday as 7", () => {
    const cron = parseCron("*/20 8-10 * JAN,mar sun,7")!;
    expect(cron.minutes).toEqual([0, 20, 40]);
    expect(cron.hours).toEqual([8, 9, 10]);
    expect([...cron.months]).toEqual([1, 3]);
    expect([...cron.weekdays]).toEqual([0]);
  });
  it("refuses out-of-range fields", () => {
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("0 0 32 * *")).toBeNull();
    expect(parseCron("0 0 5-1 * *")).toBeNull();
  });
});

describe("nextScheduledRun", () => {
  it("runs a daily time in the zone", () => {
    expect(next({ frequency: "daily", time: "09:00" }, "Europe/Istanbul", "2026-10-22T05:00:00Z")).toBe("2026-10-22T06:00:00.000Z");
    expect(next({ frequency: "daily", time: "09:00" }, "Europe/Istanbul", "2026-10-22T06:00:00Z")).toBe("2026-10-23T06:00:00.000Z");
  });
  it("runs a time the clocks skip just after the change", () => {
    // 02:30 doesn't exist in Berlin on 29 March 2026.
    expect(next({ frequency: "daily", time: "02:30" }, "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
  });
  it("runs a time that happens twice the first time only", () => {
    expect(next({ frequency: "daily", time: "02:30" }, "Europe/Berlin", "2026-10-24T12:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(next({ frequency: "daily", time: "02:30" }, "Europe/Berlin", "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
  });
  it("runs weekly on the chosen weekdays", () => {
    // Thursday 22 October 2026: the next Monday is the 26th, still on summer time in New York.
    expect(next({ frequency: "weekly", time: "09:00", weekdays: [1] }, "America/New_York", "2026-10-22T00:00:00Z")).toBe("2026-10-26T13:00:00.000Z");
  });
  it("runs a monthly day the month lacks on its last day", () => {
    expect(next({ frequency: "monthly", time: "09:00", days: [31] }, "Europe/Istanbul", "2027-02-01T00:00:00Z")).toBe("2027-02-28T06:00:00.000Z");
  });
  it("matches either day field when both are restricted", () => {
    // The 13th or a Friday: Friday 23 October comes first.
    expect(next({ frequency: "cron", cron: "0 12 13 * 5" }, "UTC", "2026-10-22T00:00:00Z")).toBe("2026-10-23T12:00:00.000Z");
  });
  it("steps through minutes in a zone with a half-hour offset", () => {
    expect(next({ frequency: "cron", cron: "*/15 * * * *" }, "Asia/Kolkata", "2026-10-22T10:07:00Z")).toBe("2026-10-22T10:15:00.000Z");
  });
  it("gives null for a day that never comes", () => {
    expect(next({ frequency: "cron", cron: "0 9 30 2 *" }, "UTC", "2027-02-01T00:00:00Z")).toBeNull();
  });
});

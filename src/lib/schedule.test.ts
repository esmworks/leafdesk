import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRepeatRule, type RepeatRule } from "./schedule";
import { dayNumber, isTimeZone, listTimeZones, timeZoneLabel, zonedInstant } from "./time-zone";

const rule = (r: Partial<RepeatRule>): RepeatRule => ({
  frequency: "daily",
  interval: 1,
  weekdays: [],
  time: "09:00",
  start: "2026-01-01",
  ...r,
});

/** The next `count` runs after `from`, as ISO strings. */
function runs(r: RepeatRule, timeZone: string, from: string, count = 4) {
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < count; i++) {
    at = nextOccurrence(r, timeZone, at);
    out.push(at.toISOString());
  }
  return out;
}

describe("zonedInstant", () => {
  it("turns a wall-clock time into an instant", () => {
    expect(new Date(zonedInstant(dayNumber("2026-07-01"), 9 * 60, "Europe/Istanbul")).toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(new Date(zonedInstant(dayNumber("2026-01-15"), 9 * 60, "America/New_York")).toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("moves a skipped time forward and takes the first of a repeated one", () => {
    // Berlin skips 02:00–03:00 on 2026-03-29 and repeats 02:00–03:00 on 2026-10-25.
    expect(new Date(zonedInstant(dayNumber("2026-03-29"), 2 * 60 + 30, "Europe/Berlin")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(new Date(zonedInstant(dayNumber("2026-10-25"), 2 * 60 + 30, "Europe/Berlin")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names only", () => {
    expect(isTimeZone("Europe/Istanbul")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(3)).toBe(false);
  });
});

describe("time zone names", () => {
  it("shows a renamed zone under its current name", () => {
    expect(timeZoneLabel("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(timeZoneLabel("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(timeZoneLabel("America/New_York")).toBe("America/New York");
  });

  it("lists zones in label order and keeps the current one as a listed name", () => {
    const { zones, current } = listTimeZones("Europe/Kyiv");
    expect(zones).toContain(current);
    expect(timeZoneLabel(current)).toBe("Europe/Kyiv");
    const labels = zones.map(timeZoneLabel);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(listTimeZones("Europe/Istanbul").current).toBe("Europe/Istanbul");
  });
});

describe("parseRepeatRule", () => {
  it("keeps a valid rule and sorts weekdays", () => {
    expect(parseRepeatRule({ frequency: "weekly", interval: 2, weekdays: [5, 1, 1], time: "07:30", start: "2026-10-05" })).toEqual({
      frequency: "weekly",
      interval: 2,
      weekdays: [1, 5],
      time: "07:30",
      start: "2026-10-05",
    });
  });

  it("drops weekdays from other frequencies and defaults the interval", () => {
    expect(parseRepeatRule({ frequency: "daily", weekdays: [1], time: "00:00", start: "2026-10-05" })).toEqual(rule({ time: "00:00", start: "2026-10-05" }));
  });

  it("refuses what isn't a rule", () => {
    const ok = { frequency: "daily", interval: 1, time: "09:00", start: "2026-10-05" };
    expect(parseRepeatRule(null)).toBeNull();
    expect(parseRepeatRule([])).toBeNull();
    expect(parseRepeatRule({ ...ok, frequency: "hourly" })).toBeNull();
    expect(parseRepeatRule({ ...ok, interval: 0 })).toBeNull();
    expect(parseRepeatRule({ ...ok, interval: 100 })).toBeNull();
    expect(parseRepeatRule({ ...ok, interval: 1.5 })).toBeNull();
    expect(parseRepeatRule({ ...ok, time: "24:00" })).toBeNull();
    expect(parseRepeatRule({ ...ok, time: "9:00" })).toBeNull();
    expect(parseRepeatRule({ ...ok, start: "2026-02-30" })).toBeNull();
    expect(parseRepeatRule({ ...ok, start: "1999-01-01" })).toBeNull();
    expect(parseRepeatRule({ ...ok, frequency: "weekly", weekdays: [] })).toBeNull();
    expect(parseRepeatRule({ ...ok, frequency: "weekly", weekdays: [7] })).toBeNull();
    expect(parseRepeatRule({ ...ok, frequency: "weekly" })).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("runs daily, later today when the time hasn't passed", () => {
    expect(runs(rule({}), "Europe/Istanbul", "2026-10-07T05:00:00Z", 3)).toEqual([
      "2026-10-07T06:00:00.000Z",
      "2026-10-08T06:00:00.000Z",
      "2026-10-09T06:00:00.000Z",
    ]);
  });

  it("is strictly after the given instant", () => {
    expect(nextOccurrence(rule({}), "UTC", new Date("2026-10-07T09:00:00Z")).toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });

  it("waits for the first day", () => {
    expect(nextOccurrence(rule({ start: "2026-12-01" }), "UTC", new Date("2026-10-07T12:00:00Z")).toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });

  it("counts every N days from the first day", () => {
    expect(runs(rule({ interval: 3, start: "2026-10-01" }), "UTC", "2026-10-05T00:00:00Z", 3)).toEqual([
      "2026-10-07T09:00:00.000Z",
      "2026-10-10T09:00:00.000Z",
      "2026-10-13T09:00:00.000Z",
    ]);
  });

  it("runs on chosen weekdays, every other week from the first day's week", () => {
    // 2026-10-07 is a Wednesday; its week starts on Monday 2026-10-05.
    const r = rule({ frequency: "weekly", interval: 2, weekdays: [1, 5], start: "2026-10-07" });
    expect(runs(r, "UTC", "2026-10-06T00:00:00Z", 4)).toEqual([
      "2026-10-09T09:00:00.000Z", // Friday of the first week (Monday was before the first day)
      "2026-10-19T09:00:00.000Z", // Monday two weeks on
      "2026-10-23T09:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
    ]);
  });

  it("runs on weekdays only", () => {
    const r = rule({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5], start: "2026-10-01" });
    expect(runs(r, "UTC", "2026-10-09T10:00:00Z", 2)).toEqual(["2026-10-12T09:00:00.000Z", "2026-10-13T09:00:00.000Z"]);
  });

  it("runs monthly on the first day's date, on the last day of shorter months", () => {
    const r = rule({ frequency: "monthly", start: "2026-01-31" });
    expect(runs(r, "UTC", "2026-01-01T00:00:00Z", 4)).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-02-28T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-04-30T09:00:00.000Z",
    ]);
  });

  it("runs every 3 months", () => {
    expect(runs(rule({ frequency: "monthly", interval: 3, start: "2026-01-15" }), "UTC", "2026-05-01T00:00:00Z", 2)).toEqual([
      "2026-07-15T09:00:00.000Z",
      "2026-10-15T09:00:00.000Z",
    ]);
  });

  it("runs yearly, on February 28 when there is no 29th", () => {
    expect(runs(rule({ frequency: "yearly", start: "2028-02-29" }), "UTC", "2028-01-01T00:00:00Z", 3)).toEqual([
      "2028-02-29T09:00:00.000Z",
      "2029-02-28T09:00:00.000Z",
      "2030-02-28T09:00:00.000Z",
    ]);
  });

  it("runs every 2 years", () => {
    expect(runs(rule({ frequency: "yearly", interval: 2, start: "2026-03-10" }), "UTC", "2027-01-01T00:00:00Z", 2)).toEqual([
      "2028-03-10T09:00:00.000Z",
      "2030-03-10T09:00:00.000Z",
    ]);
  });

  it("keeps the wall-clock time across a change of clocks", () => {
    expect(runs(rule({ start: "2026-03-27" }), "Europe/Berlin", "2026-03-27T00:00:00Z", 3)).toEqual([
      "2026-03-27T08:00:00.000Z", // CET, UTC+1
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z", // CEST, UTC+2
    ]);
  });

  it("runs once on a day whose time happens twice", () => {
    expect(runs(rule({ time: "02:30", start: "2026-10-24" }), "Europe/Berlin", "2026-10-24T12:00:00Z", 2)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("uses the day in the time zone, not in UTC", () => {
    // 23:30 on Oct 7 in New York is already Oct 8 in UTC; the next 09:00 there is Oct 8.
    expect(nextOccurrence(rule({}), "America/New_York", new Date("2026-10-08T03:30:00Z")).toISOString()).toBe("2026-10-08T13:00:00.000Z");
    // Just after midnight in Tokyo, the 09:00 run of the same day is still ahead.
    expect(nextOccurrence(rule({}), "Asia/Tokyo", new Date("2026-10-07T15:30:00Z")).toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("catches up from long ago with one next run", () => {
    expect(nextOccurrence(rule({ frequency: "weekly", weekdays: [1], start: "2026-01-05" }), "UTC", new Date("2026-10-07T00:00:00Z")).toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
  });
});

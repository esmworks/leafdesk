import { describe, expect, it } from "vitest";
import { snoozeAllowed, snoozeChoices, snoozeMoment } from "./mail-snooze";

const zone = "Europe/Istanbul";
// 2026-10-28 is a Wednesday; Istanbul is UTC+3 all year.
const at = (iso: string) => Date.parse(iso);
const keys = (now: string) => snoozeChoices(at(now), zone).map((c) => [c.key, new Date(c.at).toISOString()]);

describe("snoozeChoices", () => {
  it("offers this evening, tomorrow, Saturday and next Monday on a weekday morning", () => {
    expect(keys("2026-10-28T06:00:00Z")).toEqual([
      ["laterToday", "2026-10-28T15:00:00.000Z"],
      ["tomorrow", "2026-10-29T05:00:00.000Z"],
      ["weekend", "2026-10-31T05:00:00.000Z"],
      ["nextWeek", "2026-11-02T05:00:00.000Z"],
    ]);
  });

  it("leaves this evening out within the hour before it", () => {
    expect(keys("2026-10-28T14:30:00Z").map(([k]) => k)).toEqual(["tomorrow", "weekend", "nextWeek"]);
  });

  it("leaves out a choice that falls on another: Saturday on Friday, next week on Sunday", () => {
    expect(keys("2026-10-30T20:00:00Z").map(([k]) => k)).toEqual(["tomorrow", "nextWeek"]);
    expect(keys("2026-11-01T06:00:00Z").map(([k]) => k)).toEqual(["laterToday", "tomorrow"]);
  });
});

describe("snoozeMoment", () => {
  const now = at("2026-10-28T06:00:00Z");
  it("takes a typed time, or the morning of a typed day", () => {
    expect(snoozeMoment({ kind: "moment", day: "2026-10-29", minutes: 900, at: "2026-10-29T12:00:00.000Z" }, now, zone)).toBe(at("2026-10-29T12:00:00Z"));
    expect(snoozeMoment({ kind: "day", day: "2026-11-05" }, now, zone)).toBe(at("2026-11-05T05:00:00Z"));
  });

  it("refuses a moment past or too far", () => {
    expect(snoozeMoment({ kind: "day", day: "2026-10-27" }, now, zone)).toBeNull();
    expect(snoozeMoment({ kind: "day", day: "2028-01-01" }, now, zone)).toBeNull();
    expect(snoozeAllowed(now + 30_000, now)).toBe(false);
  });
});

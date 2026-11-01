import { describe, expect, it } from "vitest";
import { changeDay, clockMinutes, isDailyChangeLimit, parseQuietHours, quietUntil } from "./quiet-hours";

const at = (iso: string) => new Date(iso);

describe("clockMinutes", () => {
  it("reads HH:MM", () => {
    expect(clockMinutes("00:00")).toBe(0);
    expect(clockMinutes("07:30")).toBe(450);
    expect(clockMinutes("23:59")).toBe(1439);
  });
  it("refuses anything else", () => {
    for (const value of ["24:00", "7:30", "07:60", "0730", "", null, 450]) expect(clockMinutes(value)).toBeNull();
  });
});

describe("parseQuietHours", () => {
  it("takes two different times and a known zone", () => {
    expect(parseQuietHours({ start: "22:00", end: "07:00", timeZone: "Europe/Istanbul" })).toEqual({ start: "22:00", end: "07:00", timeZone: "Europe/Istanbul" });
  });
  it("refuses the same time twice, a bad time or an unknown zone", () => {
    expect(parseQuietHours({ start: "22:00", end: "22:00", timeZone: "UTC" })).toBeNull();
    expect(parseQuietHours({ start: "25:00", end: "07:00", timeZone: "UTC" })).toBeNull();
    expect(parseQuietHours({ start: "22:00", end: "07:00", timeZone: "Mars/Olympus" })).toBeNull();
    expect(parseQuietHours(null)).toBeNull();
  });
});

describe("quietUntil", () => {
  const night = { start: "22:00", end: "07:00", timeZone: "Europe/Istanbul" }; // UTC+3

  it("ends a window that wraps past midnight the next morning", () => {
    // 23:30 in Istanbul.
    expect(quietUntil(at("2026-10-07T20:30:00Z"), night)?.toISOString()).toBe("2026-10-08T04:00:00.000Z");
  });
  it("ends it the same morning after midnight", () => {
    // 06:00 in Istanbul.
    expect(quietUntil(at("2026-10-08T03:00:00Z"), night)?.toISOString()).toBe("2026-10-08T04:00:00.000Z");
  });
  it("is outside it during the day, and at its end", () => {
    expect(quietUntil(at("2026-10-08T09:00:00Z"), night)).toBeNull();
    expect(quietUntil(at("2026-10-08T04:00:00Z"), night)).toBeNull();
  });
  it("starts at its start", () => {
    expect(quietUntil(at("2026-10-07T19:00:00Z"), night)?.toISOString()).toBe("2026-10-08T04:00:00.000Z");
  });
  it("handles a window within one day", () => {
    const lunch = { start: "12:00", end: "13:30", timeZone: "UTC" };
    expect(quietUntil(at("2026-10-07T12:45:00Z"), lunch)?.toISOString()).toBe("2026-10-07T13:30:00.000Z");
    expect(quietUntil(at("2026-10-07T11:59:00Z"), lunch)).toBeNull();
    expect(quietUntil(at("2026-10-07T13:30:00Z"), lunch)).toBeNull();
  });
  it("ends on the right hour across the night the clocks go forward", () => {
    // New York, 2026-03-08: 02:00 EST becomes 03:00 EDT. 23:00 EST on the 7th.
    const ny = { start: "22:00", end: "07:00", timeZone: "America/New_York" };
    expect(quietUntil(at("2026-03-08T04:00:00Z"), ny)?.toISOString()).toBe("2026-03-08T11:00:00.000Z");
  });
  it("moves an end the clocks skip forward with them", () => {
    const skipped = { start: "01:00", end: "02:30", timeZone: "America/New_York" };
    // 01:30 EST on 2026-03-08; 02:30 doesn't happen that night, 03:30 EDT does.
    expect(quietUntil(at("2026-03-08T06:30:00Z"), skipped)?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("ends at the second 01:30 on the night the clocks go back, when now is past the first", () => {
    // New York, 2026-11-01: 02:00 EDT becomes 01:00 EST. 01:15 EST, the second time round.
    const early = { start: "00:00", end: "01:30", timeZone: "America/New_York" };
    expect(quietUntil(at("2026-11-01T06:15:00Z"), early)?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // 01:15 EDT, the first time round: it ends at the first 01:30.
    expect(quietUntil(at("2026-11-01T05:15:00Z"), early)?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("changeDay", () => {
  it("counts on the quiet hours' clock, else UTC's", () => {
    // 23:30 UTC is already the next day in Istanbul.
    expect(changeDay(at("2026-10-07T23:30:00Z"), "Europe/Istanbul")).toBe("2026-10-08");
    expect(changeDay(at("2026-10-07T23:30:00Z"), null)).toBe("2026-10-07");
    expect(changeDay(at("2026-10-07T23:30:00Z"), "Not/AZone")).toBe("2026-10-07");
  });
});

describe("isDailyChangeLimit", () => {
  it("takes whole numbers from 1", () => {
    expect(isDailyChangeLimit(1)).toBe(true);
    expect(isDailyChangeLimit(0)).toBe(false);
    expect(isDailyChangeLimit(2.5)).toBe(false);
    expect(isDailyChangeLimit("5")).toBe(false);
  });
});

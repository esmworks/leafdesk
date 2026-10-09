import { describe, expect, it } from "vitest";
import { checkDateOptions, dueReminderDay, relativeDay, reminderInstant } from "./date-options";
import { dayString } from "./time-zone";

const now = new Date("2026-10-10T12:00:00Z");

describe("checkDateOptions", () => {
  it("stores nothing for plain dates", () => {
    expect(checkDateOptions({ display: "date", reminderDays: null }, undefined, now)).toEqual({ ok: true, options: null });
  });

  it("sets the display and a reminder, starting now", () => {
    expect(checkDateOptions({ display: "relative" }, undefined, now)).toEqual({ ok: true, options: { display: "relative" } });
    expect(checkDateOptions({ reminderDays: 1, timeZone: "Europe/Istanbul" }, { display: "relative" }, now)).toEqual({
      ok: true,
      options: { display: "relative", reminder: { daysBefore: 1, timeZone: "Europe/Istanbul", since: now.toISOString() } },
    });
  });

  it("keeps an unchanged reminder's start, and restarts a changed one", () => {
    const reminder = { daysBefore: 1, timeZone: "Europe/Istanbul", since: "2026-01-01T00:00:00.000Z" };
    expect(checkDateOptions({ display: "date" }, { display: "relative", reminder }, now)).toEqual({ ok: true, options: { reminder } });
    expect(checkDateOptions({ reminderDays: 1, timeZone: "Europe/Istanbul" }, { reminder }, now)).toEqual({ ok: true, options: { reminder } });
    expect(checkDateOptions({ reminderDays: 7 }, { reminder }, now)).toEqual({
      ok: true,
      options: { reminder: { daysBefore: 7, timeZone: "Europe/Istanbul", since: now.toISOString() } },
    });
    expect(checkDateOptions({ reminderDays: null }, { reminder }, now)).toEqual({ ok: true, options: null });
  });

  it("moves a reminder to another zone given alone, keeping its days", () => {
    const reminder = { daysBefore: 2, timeZone: "UTC", since: "2026-01-01T00:00:00.000Z" };
    expect(checkDateOptions({ timeZone: "Europe/Istanbul" }, { reminder }, now)).toEqual({
      ok: true,
      options: { reminder: { daysBefore: 2, timeZone: "Europe/Istanbul", since: now.toISOString() } },
    });
    // Without a reminder there is nothing to move.
    expect(checkDateOptions({ timeZone: "Europe/Istanbul" }, undefined, now)).toEqual({ ok: true, options: null });
  });

  it("defaults the zone to UTC and refuses what it can't use", () => {
    expect(checkDateOptions({ reminderDays: 0 }, undefined, now)).toMatchObject({ options: { reminder: { timeZone: "UTC" } } });
    expect(checkDateOptions({ reminderDays: 3 }, undefined, now).ok).toBe(false);
    expect(checkDateOptions({ display: "weird" as "date" }, undefined, now).ok).toBe(false);
    expect(checkDateOptions({ reminderDays: 1, timeZone: "Mars/Olympus" }, undefined, now).ok).toBe(false);
  });
});

describe("reminder times", () => {
  const reminder = { daysBefore: 1, timeZone: "Europe/Istanbul" };

  it("goes at 9:00 in the zone, days before the date", () => {
    // Istanbul is UTC+3: 9:00 there is 6:00 UTC.
    expect(new Date(reminderInstant("2026-10-16", reminder)).toISOString()).toBe("2026-10-15T06:00:00.000Z");
    expect(new Date(reminderInstant("2026-10-16", { daysBefore: 0, timeZone: "America/New_York" })).toISOString()).toBe(
      "2026-10-16T13:00:00.000Z",
    );
  });

  it("finds the date whose reminder went last", () => {
    // 8:59 in Istanbul: today's reminders (for tomorrow) haven't gone yet; yesterday's (for today) have.
    expect(dayString(dueReminderDay(reminder, Date.parse("2026-10-10T05:59:00Z")))).toBe("2026-10-10");
    expect(dayString(dueReminderDay(reminder, Date.parse("2026-10-10T06:00:00Z")))).toBe("2026-10-11");
    expect(dayString(dueReminderDay({ daysBefore: 7, timeZone: "UTC" }, Date.parse("2026-10-10T23:00:00Z")))).toBe("2026-10-17");
  });

  it("agrees with reminderInstant", () => {
    for (const at of ["2026-10-10T05:59:00Z", "2026-10-10T06:00:00Z", "2026-03-29T07:30:00Z"]) {
      const due = dayString(dueReminderDay(reminder, Date.parse(at)));
      expect(reminderInstant(due, reminder)).toBeLessThanOrEqual(Date.parse(at));
      expect(reminderInstant(dayString(dueReminderDay(reminder, Date.parse(at)) + 1), reminder)).toBeGreaterThan(Date.parse(at));
    }
  });
});

describe("relativeDay", () => {
  it("says days near today relatively", () => {
    expect(relativeDay("2026-10-10", "2026-10-10", "en")).toBe("today");
    expect(relativeDay("2026-10-11", "2026-10-10", "en")).toBe("tomorrow");
    expect(relativeDay("2026-10-13", "2026-10-10", "en")).toBe("in 3 days");
    expect(relativeDay("2026-10-08", "2026-10-10", "en")).toBe("2 days ago");
    expect(relativeDay("2026-10-11", "2026-10-10", "tr")).toBe("yarın");
  });

  it("leaves farther dates as dates", () => {
    expect(relativeDay("2026-10-17", "2026-10-10", "en")).toBeNull();
    expect(relativeDay("2026-10-16", "2026-10-10", "en")).toBe("in 6 days");
  });
});

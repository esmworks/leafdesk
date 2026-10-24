import { describe, expect, it } from "vitest";
import { checkedUntil, MAX_VERIFICATION_MS, remindsBefore, REMIND_BEFORE_MS, verificationEnd, verificationExpired, verificationUntil } from "./verification";

const NOW = new Date("2026-01-31T10:00:00.000Z");

describe("verificationEnd", () => {
  it("runs a week, or one, three or twelve months, to the same day of the month", () => {
    expect(verificationEnd("week", NOW).toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(verificationEnd("quarter", new Date("2026-03-15T08:00:00Z")).toISOString()).toBe("2026-06-15T08:00:00.000Z");
    expect(verificationEnd("year", new Date("2026-03-15T08:00:00Z")).toISOString()).toBe("2027-03-15T08:00:00.000Z");
  });

  it("ends on the month's last day when it has no such day", () => {
    expect(verificationEnd("month", NOW).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(verificationEnd("quarter", new Date("2026-11-30T00:00:00Z")).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(verificationEnd("year", new Date("2028-02-29T00:00:00Z")).toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });
});

describe("verificationUntil", () => {
  it("takes a duration, forever, or a day through its end in UTC", () => {
    expect(verificationUntil("week", NOW)?.toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(verificationUntil("forever", NOW)).toBeNull();
    expect(verificationUntil("2026-03-01", NOW)?.toISOString()).toBe("2026-03-01T23:59:59.999Z");
  });

  it("refuses anything else, days that don't exist, have passed or are too far off", () => {
    for (const value of ["", "fortnight", "Week", "2026-02-30", "2026-1-5", "2026-01-30", "2032-01-01"]) {
      expect(verificationUntil(value, NOW)).toBeUndefined();
    }
    // Today still counts: it runs to the end of the day.
    expect(verificationUntil("2026-01-31", NOW)).toBeInstanceOf(Date);
  });
});

describe("checkedUntil", () => {
  it("keeps ends after now and within the limit", () => {
    expect(checkedUntil(new Date(NOW.getTime() + 1), NOW)).toBeInstanceOf(Date);
    expect(checkedUntil(NOW, NOW)).toBeUndefined();
    expect(checkedUntil(new Date(NOW.getTime() + MAX_VERIFICATION_MS + 1), NOW)).toBeUndefined();
    expect(checkedUntil(new Date(Number.NaN), NOW)).toBeUndefined();
  });
});

describe("verificationExpired and remindsBefore", () => {
  it("expires at its end, never without one", () => {
    expect(verificationExpired(null, NOW)).toBe(false);
    expect(verificationExpired(NOW.toISOString(), NOW)).toBe(true);
    expect(verificationExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });

  it("reminds ahead only when the end is further off than the reminder's lead", () => {
    expect(remindsBefore(null, NOW)).toBe(false);
    expect(remindsBefore(new Date(NOW.getTime() + REMIND_BEFORE_MS), NOW)).toBe(false);
    expect(remindsBefore(new Date(NOW.getTime() + REMIND_BEFORE_MS + 1), NOW)).toBe(true);
  });
});

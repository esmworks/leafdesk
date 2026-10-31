import { describe, expect, it } from "vitest";
import { MAX_REMINDER_CHARS, reminderText, reminderTime } from "./ai-reminders";

const now = new Date("2026-10-31T18:00:00Z");

describe("reminderTime", () => {
  it("reads a time with its offset", () => {
    expect(reminderTime("2026-11-01T09:00+03:00", now, "UTC")).toEqual({ at: new Date("2026-11-01T06:00:00Z") });
    expect(reminderTime("2026-11-01T06:00:00Z", now, "Europe/Istanbul")).toEqual({ at: new Date("2026-11-01T06:00:00Z") });
  });

  it("reads a time without an offset on the zone's clock that day", () => {
    expect(reminderTime("2026-11-01T09:00", now, "Europe/Istanbul")).toEqual({ at: new Date("2026-11-01T06:00:00Z") });
    expect(reminderTime("2026-11-01T09:00", now, "UTC")).toEqual({ at: new Date("2026-11-01T09:00:00Z") });
  });

  it("keeps the hour named across a change of clocks", () => {
    // New York leaves daylight saving on 2026-11-01: 9:00 the next day is 14:00 UTC, not 13:00.
    expect(reminderTime("2026-11-02T09:00", now, "America/New_York")).toEqual({ at: new Date("2026-11-02T14:00:00Z") });
    expect(reminderTime("2026-10-31T23:00", now, "America/New_York")).toEqual({ at: new Date("2026-11-01T03:00:00Z") });
  });

  it("refuses what isn't a time", () => {
    expect(reminderTime("tomorrow at 9", now, "UTC")).toEqual({ error: "format" });
    expect(reminderTime(42, now, "UTC")).toEqual({ error: "format" });
    expect(reminderTime("2026-13-45T09:00", now, "UTC")).toEqual({ error: "format" });
    expect(reminderTime("2026-11-01T24:30", now, "UTC")).toEqual({ error: "format" });
    expect(reminderTime("2026-13-45T99:99+03:00", now, "UTC")).toEqual({ error: "format" });
  });

  it("sends one a few minutes late at once, and refuses older ones", () => {
    expect(reminderTime("2026-10-31T17:58:00Z", now, "UTC")).toEqual({ at: now });
    expect(reminderTime("2026-10-31T17:00:00Z", now, "UTC")).toEqual({ error: "past" });
  });

  it("refuses one more than 30 days ahead", () => {
    expect(reminderTime("2026-11-29T18:00:00Z", now, "UTC")).toHaveProperty("at");
    expect(reminderTime("2026-12-01T18:00:00Z", now, "UTC")).toEqual({ error: "tooFar" });
  });
});

describe("reminderText", () => {
  it("drops control characters and cuts long texts", () => {
    expect(reminderText("  Call\u0007 Ayşe  ")).toBe("Call Ayşe");
    expect(reminderText("a\n\n\n\nb")).toBe("a\n\nb");
    expect(reminderText("x".repeat(400))).toHaveLength(MAX_REMINDER_CHARS);
    expect(reminderText(null)).toBe("");
  });
});

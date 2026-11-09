import { describe, expect, it } from "vitest";
import { comesAt, phraseInstant } from "./scheduled";

describe("phraseInstant", () => {
  it("takes a moment as it is", () => {
    expect(phraseInstant({ kind: "moment", day: "2026-11-20", minutes: 1020, at: "2026-11-20T14:00:00.000Z" }, "Europe/Istanbul").toISOString()).toBe("2026-11-20T14:00:00.000Z");
  });

  it("reads a day alone as 9:00 on the person's clock", () => {
    expect(phraseInstant({ kind: "day", day: "2026-11-20" }, "Europe/Istanbul").toISOString()).toBe("2026-11-20T06:00:00.000Z");
    expect(phraseInstant({ kind: "day", day: "2026-11-20" }, "America/New_York").toISOString()).toBe("2026-11-20T14:00:00.000Z");
  });
});

describe("comesAt", () => {
  // Monday 9 November 2026, 10:00 in Istanbul.
  const now = new Date("2026-11-09T07:00:00Z");

  it("shows the time alone today", () => {
    expect(comesAt(new Date("2026-11-09T14:30:00Z"), "en-GB", "Europe/Istanbul", now)).toBe("17:30");
  });

  it("shows the weekday and time within the week ahead", () => {
    expect(comesAt(new Date("2026-11-13T06:00:00Z"), "en-GB", "Europe/Istanbul", now)).toBe("Fri 09:00");
  });

  it("shows the date and time further on", () => {
    expect(comesAt(new Date("2026-11-20T06:00:00Z"), "en-GB", "Europe/Istanbul", now)).toBe("20 Nov, 9:00");
  });

  it("counts days on the person's clock, not the server's", () => {
    // Both are the 9th in UTC: 23:30 on the 9th in Istanbul is today there, 00:30 on the 10th tomorrow.
    expect(comesAt(new Date("2026-11-09T20:30:00Z"), "en-GB", "Europe/Istanbul", now)).toBe("23:30");
    expect(comesAt(new Date("2026-11-09T21:30:00Z"), "en-GB", "Europe/Istanbul", now)).toBe("Tue 00:30");
  });
});

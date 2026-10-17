import { describe, expect, it } from "vitest";
import { addDays, dailyNotePosition, dailyNoteTitle, monthOf, today } from "./journal";

describe("today", () => {
  // 2026-10-17 22:30 UTC: still the 17th in London, already the 18th in Istanbul (UTC+3).
  const late = Date.UTC(2026, 9, 17, 22, 30);

  it("is the day in the given time zone", () => {
    expect(today("Europe/Istanbul", late)).toBe("2026-10-18");
    expect(today("UTC", late)).toBe("2026-10-17");
    expect(today("America/Los_Angeles", late)).toBe("2026-10-17");
  });

  it("counts from the zone's own midnight across a clock change", () => {
    // Clocks go back in Berlin on 2026-10-25 at 03:00 local time: 23:30 UTC on the 25th is 00:30 on the 26th there.
    expect(today("Europe/Berlin", Date.UTC(2026, 9, 25, 23, 30))).toBe("2026-10-26");
    expect(today("Europe/Berlin", Date.UTC(2026, 9, 25, 22, 30))).toBe("2026-10-25");
  });

  it("falls back to UTC for what isn't a time zone", () => {
    expect(today("Mars/Olympus", late)).toBe("2026-10-17");
  });
});

describe("addDays and monthOf", () => {
  it("moves across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("gives a month's first and last day", () => {
    expect(monthOf("2026-10-17")).toEqual({ first: "2026-10-01", last: "2026-10-31" });
    expect(monthOf("2026-12-05")).toEqual({ first: "2026-12-01", last: "2026-12-31" });
    expect(monthOf("2028-02-10")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
  });
});

describe("dailyNoteTitle", () => {
  it("is the day as a long date in the language", () => {
    expect(dailyNoteTitle("2026-10-17", "en")).toBe("October 17, 2026");
    expect(dailyNoteTitle("2026-10-17", "tr")).toBe("17 Ekim 2026");
    expect(dailyNoteTitle("2026-10-17", "de")).toBe("17. Oktober 2026");
  });

  it("never shifts the day, whatever the runtime's zone", () => {
    expect(dailyNoteTitle("2026-01-01", "en")).toBe("January 1, 2026");
  });
});

describe("dailyNotePosition", () => {
  it("lists later days first, above pages added by hand", () => {
    const days = ["2026-10-12", "2026-10-20", "2026-10-17"];
    const sorted = [...days].sort((a, b) => dailyNotePosition(a) - dailyNotePosition(b));
    expect(sorted).toEqual(["2026-10-20", "2026-10-17", "2026-10-12"]);
    expect(dailyNotePosition("2026-10-17")).toBeLessThan(1);
  });
});

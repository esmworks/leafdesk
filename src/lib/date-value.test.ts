import { describe, expect, it } from "vitest";
import {
  checkDateInput,
  dateDraft,
  dateDays,
  dateMillis,
  dateOverlaps,
  dateSortKey,
  dateStartDay,
  draftValue,
  extendDraft,
  formatDateValueIn,
  parseDateValue,
  setDateDays,
  shiftDateValue,
  withDateEnd,
} from "./date-value";
import { dayNumber } from "./time-zone";

describe("parseDateValue", () => {
  it("reads the four shapes", () => {
    expect(parseDateValue("2026-10-12")).toEqual({ start: "2026-10-12", end: null, time: false });
    expect(parseDateValue("2026-10-12/2026-10-14")).toEqual({ start: "2026-10-12", end: "2026-10-14", time: false });
    expect(parseDateValue("2026-10-12T11:30:00.000Z")).toEqual({ start: "2026-10-12T11:30:00.000Z", end: null, time: true });
    expect(parseDateValue("2026-10-12T11:30:00Z/2026-10-12T13:00:00Z")).toEqual({
      start: "2026-10-12T11:30:00.000Z",
      end: "2026-10-12T13:00:00.000Z",
      time: true,
    });
  });

  it("refuses what isn't a date", () => {
    for (const v of [null, 3, "", "2026-02-30", "2026-10-12T11:30", "2026-10-12/2026-10-14T10:00:00Z", "soon", "2026-10-12/"]) {
      expect(parseDateValue(v)).toBeNull();
    }
  });

  it("drops an end before the start", () => {
    expect(parseDateValue("2026-10-14/2026-10-12")).toEqual({ start: "2026-10-14", end: null, time: false });
  });
});

describe("checkDateInput", () => {
  it("keeps a day exactly as given", () => {
    expect(checkDateInput("2026-10-12", "Due")).toEqual({ ok: true, value: "2026-10-12" });
  });

  it("stores instants in UTC and takes {start, end}", () => {
    expect(checkDateInput("2026-10-12T14:30+03:00", "Due")).toEqual({ ok: true, value: "2026-10-12T11:30:00.000Z" });
    expect(checkDateInput({ start: "2026-10-12", end: "2026-10-14" }, "Due")).toEqual({ ok: true, value: "2026-10-12/2026-10-14" });
    expect(checkDateInput({ start: "2026-10-12", end: null }, "Due")).toEqual({ ok: true, value: "2026-10-12" });
    expect(checkDateInput("2026-10-12T10:00:00Z / 2026-10-12T12:00:00Z", "Due")).toEqual({
      ok: true,
      value: "2026-10-12T10:00:00.000Z/2026-10-12T12:00:00.000Z",
    });
  });

  it("refuses ends before starts, mixed kinds and times without a zone", () => {
    expect(checkDateInput("2026-10-14/2026-10-12", "Due")).toMatchObject({ ok: false, message: expect.stringContaining("ends before") });
    expect(checkDateInput("2026-10-12/2026-10-14T10:00:00Z", "Due")).toMatchObject({ ok: false });
    expect(checkDateInput("2026-10-12T14:30", "Due")).toMatchObject({ ok: false, message: expect.stringContaining("zone") });
    expect(checkDateInput({ start: 5 }, "Due")).toMatchObject({ ok: false });
    expect(checkDateInput(["2026-10-12"], "Due")).toMatchObject({ ok: false });
  });
});

describe("dateDays", () => {
  it("covers a day range's days", () => {
    expect(dateDays("2026-10-12/2026-10-14", "Asia/Tokyo")).toEqual({ start: dayNumber("2026-10-12"), end: dayNumber("2026-10-14") });
  });

  it("places instants on the viewer's day", () => {
    // 22:30 UTC on the 11th is the 12th in Istanbul.
    expect(dateStartDay("2026-10-11T22:30:00.000Z", "Europe/Istanbul")).toBe("2026-10-12");
    expect(dateStartDay("2026-10-11T22:30:00.000Z", "UTC")).toBe("2026-10-11");
  });

  it("doesn't reach into the day a range of times ends at midnight of", () => {
    expect(dateDays("2026-10-12T20:00:00.000Z/2026-10-13T00:00:00.000Z", "UTC")).toEqual({
      start: dayNumber("2026-10-12"),
      end: dayNumber("2026-10-12"),
    });
  });

  it("tells overlaps", () => {
    expect(dateOverlaps("2026-10-12/2026-10-14", "2026-10-14", "2026-10-20", "UTC")).toBe(true);
    expect(dateOverlaps("2026-10-12/2026-10-14", "2026-10-15", "2026-10-20", "UTC")).toBe(false);
    expect(dateOverlaps("2026-10-12", "2026-10-01", "2026-10-12", "UTC")).toBe(true);
  });
});

describe("dateSortKey", () => {
  it("sorts a day before the times on it", () => {
    const day = dateSortKey("2026-10-12", "Europe/Istanbul")!;
    const early = dateSortKey("2026-10-11T22:30:00.000Z", "Europe/Istanbul")!;
    const before = dateSortKey("2026-10-11", "Europe/Istanbul")!;
    expect(before).toBeLessThan(day);
    expect(day).toBeLessThan(early);
  });
});

describe("dateMillis", () => {
  it("gives UTC milliseconds of both ends", () => {
    expect(dateMillis("2026-10-12/2026-10-14")).toEqual({ start: Date.UTC(2026, 9, 12), end: Date.UTC(2026, 9, 14), time: false });
    expect(dateMillis("2026-10-12T10:00:00.000Z")).toEqual({ start: Date.UTC(2026, 9, 12, 10), end: Date.UTC(2026, 9, 12, 10), time: true });
  });
});

describe("shiftDateValue", () => {
  it("moves both ends of a day range", () => {
    expect(shiftDateValue("2026-10-12/2026-10-14", 3)).toBe("2026-10-15/2026-10-17");
    expect(shiftDateValue("2026-10-12", -12)).toBe("2026-09-30");
  });

  it("keeps the time on the clock across a change of clocks", () => {
    // Berlin leaves summer time on 2026-10-25: 14:30 is 12:30 UTC before and 13:30 UTC after.
    expect(shiftDateValue("2026-10-24T12:30:00.000Z/2026-10-24T13:30:00.000Z", 2, "Europe/Berlin")).toBe(
      "2026-10-26T13:30:00.000Z/2026-10-26T14:30:00.000Z",
    );
  });

  it("keeps the time on the clock when moving from a day the clocks change", () => {
    // 14:30 on Los Angeles' 25-hour day (PST) is 14:30 PST the day after.
    expect(shiftDateValue("2026-11-01T22:30:00.000Z", 1, "America/Los_Angeles")).toBe("2026-11-02T22:30:00.000Z");
    // 10:00 on its 23-hour day (PDT) is 10:00 PDT the day after.
    expect(shiftDateValue("2026-03-08T17:00:00.000Z", 1, "America/Los_Angeles")).toBe("2026-03-09T17:00:00.000Z");
  });
});

describe("setDateDays", () => {
  it("stretches and shrinks day values", () => {
    const span = (a: string, b: string) => ({ start: dayNumber(a), end: dayNumber(b) });
    expect(setDateDays("2026-10-12", span("2026-10-12", "2026-10-15"))).toBe("2026-10-12/2026-10-15");
    expect(setDateDays("2026-10-12/2026-10-15", span("2026-10-13", "2026-10-13"))).toBe("2026-10-13");
    expect(setDateDays(null, span("2026-10-13", "2026-10-13"))).toBe("2026-10-13");
  });

  it("keeps times of day", () => {
    const span = { start: dayNumber("2026-10-13"), end: dayNumber("2026-10-14") };
    expect(setDateDays("2026-10-12T09:00:00.000Z/2026-10-12T10:00:00.000Z", span, "UTC")).toBe(
      "2026-10-13T09:00:00.000Z/2026-10-14T10:00:00.000Z",
    );
    expect(setDateDays("2026-10-12T09:00:00.000Z", { start: span.start, end: span.start }, "UTC")).toBe("2026-10-13T09:00:00.000Z");
  });
});

describe("withDateEnd", () => {
  it("sets and drops ends of the same kind", () => {
    expect(withDateEnd("2026-10-12/2026-10-14", null)).toBe("2026-10-12");
    expect(withDateEnd("2026-10-12", "2026-10-13")).toBe("2026-10-12/2026-10-13");
    expect(withDateEnd("2026-10-12", "2026-10-11")).toBeNull();
    expect(withDateEnd("2026-10-12", "2026-10-13T10:00:00Z")).toBeNull();
  });
});

describe("dateDraft and draftValue", () => {
  it("round-trip days, ranges and times on the picker's clock", () => {
    for (const value of ["2026-10-12", "2026-10-12/2026-10-14", "2026-10-12T11:30:00.000Z", "2026-10-12T11:30:00.000Z/2026-10-13T08:00:00.000Z"]) {
      expect(draftValue(dateDraft(value, "Europe/Istanbul")!, "Europe/Istanbul")).toBe(value);
    }
    expect(dateDraft("2026-10-12T11:30:00.000Z", "Europe/Istanbul")).toEqual({
      start: "2026-10-12",
      end: null,
      time: true,
      startMinutes: 14 * 60 + 30,
      endMinutes: 15 * 60 + 30,
    });
  });

  it("read the clock, not the time since midnight, on days the clocks change", () => {
    // Los Angeles: summer time ends 2026-11-01 at 02:00 (a 25-hour day) and starts 2026-03-08 at
    // 02:00 (a 23-hour day). Santiago starts summer time at midnight on 2026-09-06 (00:00 → 01:00).
    const cases: [string, string, number][] = [
      ["2026-11-01T22:30:00.000Z", "America/Los_Angeles", 14 * 60 + 30],
      ["2026-03-08T17:00:00.000Z", "America/Los_Angeles", 10 * 60],
      ["2026-09-06T13:00:00.000Z", "America/Santiago", 10 * 60],
      ["2026-10-25T12:30:00.000Z", "Europe/Berlin", 13 * 60 + 30],
    ];
    for (const [value, zone, minutes] of cases) {
      expect(dateDraft(value, zone)!.startMinutes).toBe(minutes);
      expect(draftValue(dateDraft(value, zone)!, zone)).toBe(value);
    }
  });

  it("never stores an end before the start", () => {
    expect(draftValue({ start: "2026-10-12", end: "2026-10-10", time: false, startMinutes: 0, endMinutes: 0 }, "UTC")).toBe("2026-10-12");
    expect(draftValue({ start: "2026-10-12", end: "2026-10-12", time: false, startMinutes: 0, endMinutes: 0 }, "UTC")).toBe("2026-10-12");
    expect(draftValue({ start: "2026-10-12", end: "2026-10-12", time: true, startMinutes: 600, endMinutes: 540 }, "UTC")).toBe(
      "2026-10-12T10:00:00.000Z/2026-10-12T10:00:00.000Z",
    );
    expect(draftValue({ start: "", end: null, time: false, startMinutes: 0, endMinutes: 0 }, "UTC")).toBeNull();
  });
});

describe("formatDateValueIn", () => {
  it("prints days, ranges and times", () => {
    expect(formatDateValueIn("2026-10-12", "en-US", "Asia/Tokyo")).toBe("Oct 12, 2026");
    expect(formatDateValueIn("2026-10-12/2026-10-14", "en-US", "UTC")).toBe("Oct 12 → Oct 14, 2026");
    expect(formatDateValueIn("2026-12-30/2027-01-02", "en-US", "UTC")).toBe("Dec 30, 2026 → Jan 2, 2027");
    expect(formatDateValueIn("2026-10-12T11:30:00.000Z", "en-GB", "Europe/Istanbul")).toBe("12 Oct 2026, 14:30");
    expect(formatDateValueIn("2026-10-12T11:30:00.000Z/2026-10-12T13:00:00.000Z", "en-GB", "Europe/Istanbul")).toBe(
      "12 Oct 2026, 14:30 → 16:00",
    );
    expect(formatDateValueIn("2026-10-12T11:30:00.000Z", "en-US", "UTC")).toBe("Oct 12, 2026, 11:30 AM");
  });
});

describe("extendDraft", () => {
  const draft = { start: "2026-10-12", end: null, time: false, startMinutes: 9 * 60, endMinutes: 10 * 60 };

  it("ends the range on a later day, the start staying", () => {
    expect(extendDraft(draft, "2026-10-15")).toEqual({ ...draft, end: "2026-10-15" });
    expect(draftValue(extendDraft(draft, "2026-10-15"), "UTC")).toBe("2026-10-12/2026-10-15");
  });

  it("starts the range on an earlier day, ending it on the old start", () => {
    expect(extendDraft(draft, "2026-10-09")).toMatchObject({ start: "2026-10-09", end: "2026-10-12" });
    expect(extendDraft({ ...draft, end: "2026-10-20" }, "2026-10-09")).toMatchObject({ start: "2026-10-09", end: "2026-10-12" });
  });

  it("moves an end it already has", () => {
    expect(extendDraft({ ...draft, end: "2026-10-20" }, "2026-10-14")).toMatchObject({ start: "2026-10-12", end: "2026-10-14" });
  });

  it("gives a new end the hour after the start and keeps an end it had", () => {
    const timed = { ...draft, time: true, startMinutes: 14 * 60, endMinutes: 9 * 60 };
    expect(extendDraft(timed, "2026-10-13")).toMatchObject({ end: "2026-10-13", endMinutes: 15 * 60 });
    expect(extendDraft({ ...timed, end: "2026-10-14", endMinutes: 11 * 60 }, "2026-10-13")).toMatchObject({ endMinutes: 11 * 60 });
    // On the start's own day the end isn't before the start.
    expect(extendDraft({ ...timed, end: "2026-10-14", endMinutes: 11 * 60 }, "2026-10-12")).toMatchObject({ end: "2026-10-12", endMinutes: 14 * 60 });
  });
});

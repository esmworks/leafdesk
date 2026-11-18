import { describe, expect, it } from "vitest";
import {
  atLeastLong,
  bookableSlots,
  busyFromDates,
  mergeIntervals,
  parseClock,
  scheduleProblem,
  slotIsOffered,
  slotStarts,
  takeOut,
  workingWindows,
  type BookingSchedule,
} from "./booking";
import { dayNumber, zonedInstant } from "./time-zone";

const HOUR = 3_600_000;
const schedule: BookingSchedule = {
  timeZone: "UTC",
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 12 * 60,
  durationMinutes: 60,
  bufferMinutes: 0,
  daysAhead: 7,
  minNoticeMinutes: 0,
};
// 2026-11-16 is a Monday.
const monday = Date.UTC(2026, 10, 16, 0, 0);
const at = (day: string, hour: number, minute = 0) => zonedInstant(dayNumber(day), hour * 60 + minute, "UTC");

describe("busyFromDates", () => {
  it("takes times, ignores whole days and gives open-ended ones an hour", () => {
    const busy = busyFromDates(["2026-11-16", "2026-11-16/2026-11-18", "2026-11-16T10:00:00.000Z/2026-11-16T10:30:00.000Z", "2026-11-16T14:00:00.000Z", "nonsense"]);
    expect(busy).toEqual([
      { start: Date.UTC(2026, 10, 16, 10), end: Date.UTC(2026, 10, 16, 10, 30) },
      { start: Date.UTC(2026, 10, 16, 14), end: Date.UTC(2026, 10, 16, 15) },
    ]);
  });
});

describe("intervals", () => {
  it("merges overlapping and touching ones", () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 10 }, { start: 2, end: 2 }])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 10 },
    ]);
  });

  it("takes busy time out of windows, with a buffer either side", () => {
    const windows = [{ start: 0, end: 10 * HOUR }];
    const busy = [{ start: 4 * HOUR, end: 5 * HOUR }];
    expect(takeOut(windows, busy)).toEqual([
      { start: 0, end: 4 * HOUR },
      { start: 5 * HOUR, end: 10 * HOUR },
    ]);
    expect(takeOut(windows, busy, 30)).toEqual([
      { start: 0, end: 3.5 * HOUR },
      { start: 5.5 * HOUR, end: 10 * HOUR },
    ]);
    expect(atLeastLong(takeOut(windows, [{ start: 0, end: 9.5 * HOUR }]), 60)).toEqual([]);
  });

  it("cuts slots from the start of each free stretch, half an hour apart", () => {
    expect(slotStarts([{ start: 0, end: 2 * HOUR }], 60)).toEqual([0, 0.5 * HOUR, HOUR]);
    expect(slotStarts([{ start: 0, end: 40 * 60_000 }], 20)).toEqual([0, 20 * 60_000]);
  });
});

describe("working windows", () => {
  it("covers the wanted weekdays only", () => {
    const windows = workingWindows({ fromDay: dayNumber("2026-11-20"), toDay: dayNumber("2026-11-23"), weekdays: [1, 5], startMinute: 540, endMinute: 600, timeZone: "UTC" });
    expect(windows).toEqual([
      { start: at("2026-11-20", 9), end: at("2026-11-20", 10) },
      { start: at("2026-11-23", 9), end: at("2026-11-23", 10) },
    ]);
  });

  it("keeps the wall-clock hours across a change of clocks", () => {
    // Europe/Berlin springs forward on 2026-03-29: 09:00 is UTC+1 the day before and UTC+2 after it.
    const range = { fromDay: dayNumber("2026-03-28"), toDay: dayNumber("2026-03-30"), weekdays: [0, 1, 6], startMinute: 540, endMinute: 600, timeZone: "Europe/Berlin" };
    const [sat, sun, mon] = workingWindows(range);
    expect(new Date(sat.start).toISOString()).toBe("2026-03-28T08:00:00.000Z");
    expect(new Date(sun.start).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(new Date(mon.start).toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });
});

describe("bookable slots", () => {
  it("offers the working hours of the coming weekdays, none at weekends", () => {
    const slots = bookableSlots({ ...schedule, daysAhead: 6 }, [], monday);
    // Monday to Friday, 9:00 to 12:00 hourly offers at 9:00, 9:30, 10:00, 10:30, 11:00.
    expect(slots.length).toBe(5 * 5);
    expect(slots[0]).toBe(at("2026-11-16", 9));
  });

  it("leaves out slots that meet something on the calendar, with the buffer", () => {
    const busy = [{ start: at("2026-11-16", 10), end: at("2026-11-16", 10, 30) }];
    const day = (s: BookingSchedule) => bookableSlots({ ...s, daysAhead: 0 }, busy, monday);
    expect(day(schedule)).toEqual([at("2026-11-16", 9), at("2026-11-16", 10, 30), at("2026-11-16", 11)]);
    expect(day({ ...schedule, bufferMinutes: 30 })).toEqual([at("2026-11-16", 11)]);
  });

  it("holds back slots inside the notice period and past the days ahead", () => {
    const now = at("2026-11-16", 9, 15);
    expect(bookableSlots({ ...schedule, daysAhead: 0 }, [], now)[0]).toBe(at("2026-11-16", 9, 15));
    expect(bookableSlots({ ...schedule, daysAhead: 0, minNoticeMinutes: 60 }, [], now)[0]).toBe(at("2026-11-16", 10, 15));
    expect(bookableSlots({ ...schedule, daysAhead: 0 }, [], at("2026-11-21", 9)).length).toBe(0);
  });

  it("knows whether a start is still offered", () => {
    const busy = [{ start: at("2026-11-16", 9), end: at("2026-11-16", 9, 30) }];
    expect(slotIsOffered(schedule, busy, at("2026-11-16", 9), monday)).toBe(false);
    expect(slotIsOffered(schedule, busy, at("2026-11-16", 9, 30), monday)).toBe(true);
    expect(slotIsOffered(schedule, busy, at("2026-11-16", 9, 10), monday)).toBe(false);
  });
});

describe("scheduleProblem", () => {
  it("accepts a good schedule and names what is wrong with others", () => {
    expect(scheduleProblem(schedule, true)).toBeNull();
    expect(scheduleProblem(schedule, false)).toBe("timeZone");
    expect(scheduleProblem({ ...schedule, weekdays: [] }, true)).toBe("weekdays");
    expect(scheduleProblem({ ...schedule, weekdays: [1, 1] }, true)).toBe("weekdays");
    expect(scheduleProblem({ ...schedule, startMinute: 13 * 60 }, true)).toBe("hours");
    expect(scheduleProblem({ ...schedule, endMinute: 9 * 60 + 30 }, true)).toBe("hours");
    expect(scheduleProblem({ ...schedule, durationMinutes: 2 }, true)).toBe("duration");
    expect(scheduleProblem({ ...schedule, bufferMinutes: 500 }, true)).toBe("buffer");
    expect(scheduleProblem({ ...schedule, daysAhead: 400 }, true)).toBe("daysAhead");
    expect(scheduleProblem({ ...schedule, minNoticeMinutes: -1 }, true)).toBe("notice");
  });

  it("reads clock times", () => {
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("24:00")).toBe(1440);
    expect(parseClock("24:30")).toBeNull();
    expect(parseClock("9:75")).toBeNull();
    expect(parseClock(5)).toBeNull();
  });
});

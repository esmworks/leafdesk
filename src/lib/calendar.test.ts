import { describe, expect, it } from "vitest";
import { calendarEvent, dayBlocks, eventsOn, isAllDay, monthWeeks, weekBars, weekDays, type CalendarEvent } from "./calendar";
import { moveDateStart } from "./date-value";
import { dayNumber, dayString } from "./time-zone";

const d = dayNumber;
const event = (id: string, value: string, timeZone = "UTC") => calendarEvent(id, value, timeZone)!;

describe("calendarEvent", () => {
  it("reads days, ranges and times on the viewer's clock", () => {
    expect(event("a", "2026-10-12/2026-10-14")).toMatchObject({ start: d("2026-10-12"), end: d("2026-10-14"), time: false });
    expect(event("b", "2026-10-12T11:30:00.000Z/2026-10-12T13:00:00.000Z", "Europe/Istanbul")).toMatchObject({
      start: d("2026-10-12"),
      end: d("2026-10-12"),
      time: true,
      startMinutes: 14 * 60 + 30,
      endMinutes: 16 * 60,
    });
    expect(event("c", "2026-10-12T09:00:00.000Z")).toMatchObject({ startMinutes: 540, endMinutes: null });
    expect(calendarEvent("d", "soon", "UTC")).toBeNull();
  });

  it("ends a range ending at midnight at the end of the day before", () => {
    const e = event("a", "2026-10-12T20:00:00.000Z/2026-10-13T00:00:00.000Z");
    expect(e).toMatchObject({ start: d("2026-10-12"), end: d("2026-10-12"), endMinutes: 24 * 60 });
    expect(isAllDay(e)).toBe(false);
    expect(isAllDay(event("b", "2026-10-12T20:00:00.000Z/2026-10-13T08:00:00.000Z"))).toBe(true);
  });
});

describe("weeks", () => {
  it("lists a week's days from its first weekday", () => {
    // 2026-10-14 is a Wednesday.
    expect(weekDays(d("2026-10-14"), 1).map(dayString)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(dayString(weekDays(d("2026-10-14"), 0)[0])).toBe("2026-10-11");
  });

  it("covers a month with whole weeks", () => {
    const weeks = monthWeeks(2026, 9, 1);
    expect(dayString(weeks[0])).toBe("2026-09-28");
    expect(dayString(weeks.at(-1)!)).toBe("2026-10-26");
    expect(weeks).toHaveLength(5);
  });
});

describe("weekBars", () => {
  const week = d("2026-10-12");

  it("puts long bars at the top and cuts them at the week's edges", () => {
    const events = [
      event("single", "2026-10-13"),
      event("long", "2026-10-08/2026-10-14"),
      event("later", "2026-10-15/2026-10-20"),
    ];
    const { bars, lanes } = weekBars(events, week);
    const byId = Object.fromEntries(bars.map((b) => [b.event.id, b]));
    expect(byId.long).toMatchObject({ col: 0, span: 3, lane: 0, before: true, after: false });
    expect(byId.single).toMatchObject({ col: 1, span: 1, lane: 1 });
    // Starts after the long one ends, so it shares its lane.
    expect(byId.later).toMatchObject({ col: 3, span: 4, lane: 0, before: false, after: true });
    expect(lanes).toBe(2);
  });

  it("leaves out events of other weeks and orders a day's events", () => {
    const events = [
      event("timed-late", "2026-10-13T15:00:00.000Z"),
      event("timed-early", "2026-10-13T08:00:00.000Z"),
      event("day", "2026-10-13"),
      event("elsewhere", "2026-10-25"),
    ];
    const { bars } = weekBars(events, week);
    expect(bars.map((b) => [b.event.id, b.lane])).toEqual([
      ["day", 0],
      ["timed-early", 1],
      ["timed-late", 2],
    ]);
    expect(eventsOn(events, d("2026-10-13")).map((e) => e.id)).toEqual(["day", "timed-early", "timed-late"]);
  });
});

describe("dayBlocks", () => {
  const timed = (id: string, start: string, end?: string) =>
    event(id, end ? `2026-10-12T${start}:00.000Z/2026-10-12T${end}:00.000Z` : `2026-10-12T${start}:00.000Z`);
  const layout = (events: CalendarEvent[]) =>
    Object.fromEntries(dayBlocks(events).map((b) => [b.event.id, [b.top, b.bottom, b.col, b.cols]]));

  it("shares the width between events at the same time only", () => {
    expect(
      layout([timed("a", "09:00", "11:00"), timed("b", "10:00", "10:30"), timed("c", "10:30", "12:00"), timed("d", "13:00", "14:00")]),
    ).toEqual({
      a: [540, 660, 0, 2],
      b: [600, 630, 1, 2],
      c: [630, 720, 1, 2],
      d: [780, 840, 0, 1],
    });
  });

  it("gives times without an end a minimum length", () => {
    expect(layout([timed("a", "23:50")])).toEqual({ a: [1430, 1440, 0, 1] });
    expect(layout([timed("a", "09:00")])).toEqual({ a: [540, 570, 0, 1] });
  });
});

describe("moveDateStart", () => {
  it("moves times keeping their length", () => {
    const at = Date.UTC(2026, 9, 13, 14);
    expect(moveDateStart("2026-10-12T09:00:00.000Z/2026-10-12T10:30:00.000Z", at)).toBe(
      "2026-10-13T14:00:00.000Z/2026-10-13T15:30:00.000Z",
    );
    expect(moveDateStart("2026-10-12T09:00:00.000Z", at)).toBe("2026-10-13T14:00:00.000Z");
    expect(moveDateStart("2026-10-12", at)).toBeNull();
  });
});

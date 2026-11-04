import { describe, expect, it } from "vitest";
import { agendaDays, isoWeek, itemMinutes, placeItems, type CalendarItem } from "./calendar-items";
import { dayNumber } from "./time-zone";

const item = (id: string, date: string, kind: CalendarItem["kind"] = "event"): CalendarItem => ({ id, kind, title: id, icon: null, date, href: `/p/${id}`, detail: null });

describe("calendar items", () => {
  it("places items on the viewer's days, leaving out what isn't a date", () => {
    const placed = placeItems([item("a", "2026-11-04T07:30:00.000Z/2026-11-04T08:15:00.000Z"), item("b", "not a date")], "Europe/Istanbul");
    expect(placed.map((p) => p.item.id)).toEqual(["a"]);
    expect(placed[0].start).toBe(dayNumber("2026-11-04"));
    expect(placed[0].startMinutes).toBe(10 * 60 + 30);
    expect(itemMinutes(placed[0])).toBe(45);
  });

  it("lists each day with all-day items first, then by time", () => {
    const placed = placeItems(
      [item("late", "2026-11-04T15:00:00.000Z"), item("day", "2026-11-04", "task"), item("early", "2026-11-04T06:00:00.000Z"), item("next", "2026-11-05", "task")],
      "UTC",
    );
    const days = agendaDays(placed, "2026-11-04", 3);
    expect(days.map((d) => d.day)).toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(days[0].items.map((p) => p.item.id)).toEqual(["day", "early", "late"]);
    expect(days[1].items.map((p) => p.item.id)).toEqual(["next"]);
    expect(days[2].items).toEqual([]);
  });

  it("gives no length to items over whole days or without an end", () => {
    const [allDay, open] = placeItems([item("a", "2026-11-04/2026-11-06"), item("b", "2026-11-04T09:00:00.000Z")], "UTC");
    expect(itemMinutes(allDay)).toBeNull();
    expect(itemMinutes(open)).toBeNull();
  });

  it("numbers weeks as ISO does", () => {
    expect(isoWeek(dayNumber("2026-11-04"))).toBe(45);
    expect(isoWeek(dayNumber("2026-01-01"))).toBe(1);
    expect(isoWeek(dayNumber("2027-01-01"))).toBe(53);
    expect(isoWeek(dayNumber("2024-12-30"))).toBe(1);
  });
});

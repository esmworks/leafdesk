import { describe, expect, it } from "vitest";
import { agendaDays, droppedDate, isoWeek, itemMinutes, placeItems, reminderItem, type CalendarItem } from "./calendar-items";
import { dayNumber } from "./time-zone";

const item = (id: string, date: string, kind: CalendarItem["kind"] = "event"): CalendarItem => ({ id, kind, title: id, icon: null, date, href: `/p/${id}`, detail: null, moves: { allDay: true } });

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

  it("gives a dropped item its new day or time", () => {
    const zone = "Europe/Istanbul";
    const thursday = dayNumber("2026-11-05");
    const [todo, call, trip] = placeItems([item("todo", "2026-11-05", "task"), item("call", "2026-11-04T07:00:00.000Z/2026-11-04T07:45:00.000Z"), item("trip", "2026-11-02/2026-11-04")], zone);
    // A day dropped at 14:00 there is that time, without an end.
    expect(droppedDate(todo, { day: thursday, minutes: 14 * 60 }, zone)).toBe("2026-11-05T11:00:00.000Z");
    // A time keeps its length; dropped on the all-day strip it is the day.
    expect(droppedDate(call, { day: thursday, minutes: 9 * 60 + 15 }, zone)).toBe("2026-11-05T06:15:00.000Z/2026-11-05T07:00:00.000Z");
    expect(droppedDate(call, { day: thursday, minutes: null }, zone)).toBe("2026-11-05");
    // Days keep how many there were, from the day it was picked up at.
    expect(droppedDate(trip, { day: thursday, minutes: null }, zone, 1)).toBe("2026-11-04/2026-11-06");
    expect(droppedDate(todo, { day: thursday, minutes: null }, zone)).toBeNull();
  });

  it("puts a reminder still to come at its time, moving only to another time", () => {
    const at = new Date("2026-11-05T06:00:00.000Z");
    const fromAgent = reminderItem({ id: "n1", text: "  Call   Ayşe\nabout the offer ", at, pageId: "p1", agentName: "Desk helper", own: false }, "w1");
    expect(fromAgent).toEqual({
      id: "reminder:n1",
      kind: "reminder",
      title: "Call Ayşe about the offer",
      icon: null,
      date: "2026-11-05T06:00:00.000Z",
      href: "/w/w1/p/p1",
      detail: "Desk helper",
      moves: { allDay: false },
    });
    // About no page it opens the inbox; set by the person themselves, no one is named.
    const own = reminderItem({ id: "n2", text: "x".repeat(300), at, pageId: null, agentName: null, own: true }, "w1");
    expect(own.href).toBeNull();
    expect(own.detail).toBeNull();
    expect(own.title).toHaveLength(200);
    expect(own.title.endsWith("…")).toBe(true);
    // Dropped on another time it is that time, with no end.
    const [placed] = placeItems([fromAgent], "Europe/Istanbul");
    expect(placed.time).toBe(true);
    expect(droppedDate(placed, { day: dayNumber("2026-11-06"), minutes: 14 * 60 + 30 }, "Europe/Istanbul")).toBe("2026-11-06T11:30:00.000Z");
  });
});

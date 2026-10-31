import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import {
  agendaDateProperty,
  agendaDefaults,
  agendaDoneValue,
  agendaPriorityProperty,
  agendaSections,
  agendaStatusProperty,
  isAgendaDone,
  movedDate,
  openRowsPerDay,
  postponedDate,
  showsUndated,
  stripDays,
} from "./agenda";
import { layoutConfigError } from "./views";
import { layoutDefaults } from "./view-layouts";
import { dropPropertyReferences } from "./duplicate";

const prop = (id: string, type: PropertyType, options: PropertyOptions = {}) => ({ id, type, options });
const due = prop("due", "date");
const status = prop("status", "status", {
  options: [
    { id: "todo", name: "To do", color: "gray", group: "todo" },
    { id: "doing", name: "Doing", color: "blue", group: "in_progress" },
    { id: "done", name: "Done", color: "green", group: "done" },
  ],
});
const check = prop("check", "checkbox");
const priority = prop("priority", "select", {
  options: [
    { id: "high", name: "High", color: "red" },
    { id: "low", name: "Low", color: "gray" },
  ],
});
const properties = [prop("notes", "text"), due, status, check, priority];
const row = (id: string, values: Record<string, unknown>) => ({ id, properties: values });
const UTC = "UTC";
const TODAY = "2026-10-31";

describe("agenda properties", () => {
  it("place rows by the date the view names, else the first date", () => {
    expect(agendaDateProperty({}, properties)?.id).toBe("due");
    expect(agendaDateProperty({ dateBy: "notes" }, properties)?.id).toBe("due");
  });

  it("mark rows done by a status or checkbox, the first status by default", () => {
    expect(agendaStatusProperty({}, properties)?.id).toBe("status");
    expect(agendaStatusProperty({ statusBy: "check" }, properties)?.id).toBe("check");
    expect(agendaStatusProperty({ statusBy: "notes" }, properties)?.id).toBe("status");
    expect(agendaStatusProperty({}, [due, check])?.id).toBe("check");
    expect(agendaStatusProperty({}, [due])).toBeUndefined();
  });

  it("rank by a priority only while the view names one that fits", () => {
    expect(agendaPriorityProperty({}, properties)).toBeUndefined();
    expect(agendaPriorityProperty({ priorityBy: "priority" }, properties)?.id).toBe("priority");
    expect(agendaPriorityProperty({ priorityBy: "due" }, properties)).toBeUndefined();
  });

  it("show rows without a date unless the view hides them", () => {
    expect(showsUndated({})).toBe(true);
    expect(showsUndated({ showUndated: false })).toBe(false);
  });

  it("start a new agenda on the first date and the first status", () => {
    expect(agendaDefaults(properties, {})).toEqual({ dateBy: "due", statusBy: "status" });
    expect(agendaDefaults(properties, { dateBy: "x", statusBy: "check" })).toEqual({});
    expect(layoutDefaults("agenda", properties, {})).toEqual({ dateBy: "due", statusBy: "status" });
  });
});

describe("done rows", () => {
  it("are a status in the done group or a ticked checkbox", () => {
    expect(isAgendaDone(status, "done")).toBe(true);
    expect(isAgendaDone(status, "doing")).toBe(false);
    expect(isAgendaDone(check, true)).toBe(true);
    expect(isAgendaDone(check, false)).toBe(false);
    expect(isAgendaDone(undefined, true)).toBe(false);
  });

  it("are ticked off with the first done option, and back with the first to-do one", () => {
    expect(agendaDoneValue(status, true)).toBe("done");
    expect(agendaDoneValue(status, false)).toBe("todo");
    expect(agendaDoneValue(check, true)).toBe(true);
    expect(agendaDoneValue(prop("s", "status", { options: [] }), true)).toBeUndefined();
  });
});

describe("agendaSections", () => {
  const rows = [
    row("late-low", { due: "2026-10-29", priority: "low" }),
    row("late-high", { due: "2026-10-29", priority: "high" }),
    row("late-done", { due: "2026-10-28", status: "done" }),
    row("older", { due: "2026-10-20" }),
    row("evening", { due: "2026-10-31T19:00:00.000Z" }),
    row("morning", { due: "2026-10-31T07:30:00.000Z" }),
    row("all-day", { due: "2026-10-31" }),
    row("spanning", { due: "2026-10-30/2026-11-02" }),
    row("done-today", { due: "2026-10-31T10:00:00.000Z", status: "done" }),
    row("tomorrow", { due: "2026-11-01" }),
    row("undated-low", { priority: "low" }),
    row("undated-high", { priority: "high" }),
    row("undated-done", { status: "done" }),
  ];
  const sections = (day: string, extra: Partial<Parameters<typeof agendaSections>[1]> = {}) =>
    agendaSections(rows, { date: due, status, priority, day, today: TODAY, timeZone: UTC, ...extra });
  const ids = (list: { id: string }[]) => list.map((r) => r.id);

  it("lists what is overdue and not done on top, oldest first and by priority", () => {
    expect(ids(sections(TODAY).overdue)).toEqual(["older", "late-high", "late-low"]);
  });

  it("lists the day's rows by time, whole days first, done ones included", () => {
    expect(ids(sections(TODAY).day)).toEqual(["spanning", "all-day", "morning", "done-today", "evening"]);
  });

  it("lists rows without a date that aren't done by priority, unless hidden", () => {
    expect(ids(sections(TODAY).undated)).toEqual(["undated-high", "undated-low"]);
    expect(sections(TODAY, { undated: false }).undated).toEqual([]);
  });

  it("shows overdue rows on today only", () => {
    const tomorrow = sections("2026-11-01");
    expect(tomorrow.overdue).toEqual([]);
    expect(ids(tomorrow.day)).toEqual(["spanning", "tomorrow"]);
  });

  it("places times on the viewer's day", () => {
    // 23:30 UTC on the 30th is already the 31st in Istanbul.
    const late = [row("night", { due: "2026-10-30T23:30:00.000Z" })];
    expect(ids(agendaSections(late, { date: due, status, day: TODAY, today: TODAY, timeZone: "Europe/Istanbul" }).day)).toEqual(["night"]);
    expect(ids(agendaSections(late, { date: due, status, day: TODAY, today: TODAY, timeZone: UTC }).overdue)).toEqual(["night"]);
  });

  it("keeps the view's order for rows the agenda ranks the same", () => {
    const same = [row("b", { due: TODAY }), row("a", { due: TODAY })];
    expect(ids(agendaSections(same, { date: due, status: undefined, day: TODAY, today: TODAY, timeZone: UTC }).day)).toEqual(["b", "a"]);
  });

  it("puts every row without a date property in the undated section", () => {
    const result = agendaSections(rows.slice(0, 2), { date: undefined, status, day: TODAY, today: TODAY, timeZone: UTC });
    expect(ids(result.undated)).toEqual(["late-low", "late-high"]);
  });
});

describe("moving dates", () => {
  it("moves a date to tomorrow, keeping its kind, length and time on the clock", () => {
    expect(postponedDate("2026-10-20", TODAY, UTC)).toBe("2026-11-01");
    expect(postponedDate("2026-10-31/2026-11-02", TODAY, UTC)).toBe("2026-11-01/2026-11-03");
    expect(postponedDate("2026-10-29T14:30:00.000Z", TODAY, UTC)).toBe("2026-11-01T14:30:00.000Z");
    expect(postponedDate(null, TODAY, UTC)).toBe("2026-11-01");
  });

  it("keeps the time on the clock across a change of clocks", () => {
    // 09:00 in Berlin is 07:00 UTC in summer time and 08:00 UTC after the clocks go back on Oct 25.
    expect(postponedDate("2026-10-20T07:00:00.000Z", TODAY, "Europe/Berlin")).toBe("2026-11-01T08:00:00.000Z");
  });

  it("moves a date to any day", () => {
    expect(movedDate("2026-10-20", "2026-12-24", UTC)).toBe("2026-12-24");
    expect(movedDate(undefined, "2026-12-24", UTC)).toBe("2026-12-24");
  });
});

describe("the strip of days", () => {
  it("has two weeks from its first day, across months", () => {
    const days = stripDays(TODAY);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe(TODAY);
    expect(days[1]).toBe("2026-11-01");
    expect(days[13]).toBe("2026-11-13");
  });

  it("counts each day's rows not done, a range on each of its days", () => {
    const rows = [
      row("a", { due: TODAY }),
      row("b", { due: TODAY, check: true }),
      row("c", { due: "2026-10-30/2026-11-01" }),
      row("d", {}),
    ];
    const counts = openRowsPerDay(rows, stripDays(TODAY, 3), due, check, UTC);
    expect(Object.fromEntries(counts)).toEqual({ "2026-10-31": 2, "2026-11-01": 1, "2026-11-02": 0 });
  });
});

describe("agenda settings", () => {
  it("are checked like other view settings", () => {
    expect(layoutConfigError({ statusBy: "status", priorityBy: "priority", showUndated: false })).toBeNull();
    expect(layoutConfigError({ statusBy: 3 } as unknown as ViewConfig)).toMatch(/statusBy must be a property id/);
    expect(layoutConfigError({ showUndated: "no" } as unknown as ViewConfig)).toMatch(/showUndated must be true or false/);
  });

  it("let go of properties that are deleted", () => {
    const config = dropPropertyReferences({ dateBy: "due", statusBy: "status", priorityBy: "priority" }, (id) => id !== "due");
    expect(config).toMatchObject({ dateBy: "due", statusBy: undefined, priorityBy: undefined });
  });
});

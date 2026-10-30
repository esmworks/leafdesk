import { describe, expect, it } from "vitest";
import {
  calendarIdOf,
  createdEventId,
  eventCreate,
  eventRows,
  eventTimes,
  eventUpdate,
  gcalAccess,
  gcalWindow,
  gcalWriteAccess,
  wallTime,
  writesCalendar,
  type GcalRow,
} from "./gcal-sync";

const tools = (...names: string[]) => names.map((name) => ({ name }));

describe("who may sync through a connection", () => {
  const ready = { status: "ready", tools: tools("list_events", "create_event", "update_event"), chatTools: [] as string[] };
  it("lets owners read and write, members only with the tools allowed in chat, guests never", () => {
    expect(gcalAccess(ready, "owner")).toBe(true);
    expect(gcalWriteAccess(ready, "owner")).toBe(true);
    expect(gcalAccess(ready, "member")).toBe(false);
    expect(gcalAccess({ ...ready, chatTools: ["list_events"] }, "member")).toBe(true);
    expect(gcalWriteAccess({ ...ready, chatTools: ["list_events", "create_event"] }, "member")).toBe(false);
    expect(gcalWriteAccess({ ...ready, chatTools: ["list_events", "create_event", "update_event"] }, "member")).toBe(true);
    expect(gcalAccess({ ...ready, chatTools: ["list_events"] }, "guest")).toBe(false);
  });
  it("needs a ready connection with the tools", () => {
    expect(gcalAccess({ ...ready, status: "needsAuth" }, "owner")).toBe(false);
    expect(gcalAccess({ ...ready, tools: tools("get_event") }, "owner")).toBe(false);
    expect(gcalWriteAccess({ ...ready, tools: tools("list_events", "create_event") }, "owner")).toBe(false);
  });
});

describe("calendar ids and the window", () => {
  it("takes primary and listed ids, nothing like a path", () => {
    expect(calendarIdOf(" primary ")).toBe("primary");
    expect(calendarIdOf("team@group.calendar.google.com")).toBe("team@group.calendar.google.com");
    expect(calendarIdOf("a/b")).toBeNull();
    expect(calendarIdOf("")).toBeNull();
    expect(calendarIdOf(3)).toBeNull();
  });
  it("reads 90 days back to a year ahead, in UTC without a zone", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(gcalWindow(now)).toEqual({ startTime: "2026-08-01T12:00:00", endTime: "2027-10-30T12:00:00" });
  });
  it("knows which access lets it write", () => {
    expect(writesCalendar("owner")).toBe(true);
    expect(writesCalendar("writer")).toBe(true);
    expect(writesCalendar("reader")).toBe(false);
    expect(writesCalendar(undefined)).toBe(false);
  });
});

describe("events as rows", () => {
  const events = [
    {
      id: "late",
      summary: "Visit",
      start: { dateTime: "2026-06-15T08:30:00Z" },
      end: { dateTime: "2026-06-15T09:30:00Z" },
      location: " Ankara ",
      description: "Bring the offer",
      status: "confirmed",
      htmlLink: "https://www.google.com/calendar/event?eid=1",
      organizer: { email: "me@example.com", self: true },
    },
    { id: "days", summary: "Fair", start: { date: "2026-06-10" }, end: { date: "2026-06-13" }, organizer: { email: "x@example.com", displayName: "Ece" } },
    { id: "one", start: { date: "2026-06-01" }, end: { date: "2026-06-02" }, organizer: { email: "x@example.com" }, guestsCanModify: true, status: "tentative" },
    { id: "where", summary: "Office", start: { date: "2026-06-03" }, eventType: "workingLocation", organizer: { self: true } },
    { id: "", start: { date: "2026-06-03" } },
    { id: "nostart", summary: "Broken" },
  ];
  const rows = eventRows(events, "primary", true, "Untitled");

  it("keeps events with an id and a start, by start", () => {
    expect(rows.map((r) => r.key)).toEqual(["one", "where", "days", "late"]);
  });
  it("writes times as instants and whole days with Google's end the day after the last", () => {
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.late.when).toBe("2026-06-15T08:30:00.000Z/2026-06-15T09:30:00.000Z");
    expect(by.days.when).toBe("2026-06-10/2026-06-12");
    expect(by.one.when).toBe("2026-06-01");
  });
  it("names, places and links them", () => {
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.late).toMatchObject({ title: "Visit", summary: "Visit", location: "Ankara", status: "confirmed", organizer: "me@example.com" });
    expect(by.late.link).toBe("https://www.google.com/calendar/event?eid=1");
    expect(by.one).toMatchObject({ title: "Untitled", summary: "", status: "tentative" });
    expect(by.days.organizer).toBe("Ece <x@example.com>");
  });
  it("writes only the account's own events, those guests may change, and plain events", () => {
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.late.writable).toBe(true);
    expect(by.one.writable).toBe(true);
    expect(by.days.writable).toBe(false);
    expect(by.where.writable).toBe(false);
    expect(eventRows(events, "primary", false).some((r) => r.writable)).toBe(false);
  });
  it("counts a shared calendar's own events as its own", () => {
    const [row] = eventRows([{ id: "t", start: { date: "2026-06-01" }, organizer: { email: "team@group.calendar.google.com" } }], "team@group.calendar.google.com", true);
    expect(row.writable).toBe(true);
  });
  it("reads the connection's shape: times with an offset, guests' permissions apart", () => {
    const [mine, theirs] = eventRows(
      [
        { id: "a", summary: "Call", eventType: "DEFAULT", organizer: { email: "me@example.com", self: true }, start: { dateTime: "2026-06-11T10:00:00+03:00", timeZone: "Europe/Istanbul" }, end: { dateTime: "2026-06-11T10:15:00+03:00" } },
        { id: "b", summary: "Review", eventType: "DEFAULT", organizer: { email: "x@example.com" }, guestPermissions: { guestsCanModify: true }, start: { dateTime: "2026-06-12T14:00:00+03:00" } },
      ],
      "primary",
      true,
    );
    expect(mine).toMatchObject({ when: "2026-06-11T07:00:00.000Z/2026-06-11T07:15:00.000Z", writable: true });
    expect(theirs.writable).toBe(true);
    expect(eventRows([{ id: "c", organizer: { email: "x@example.com" }, guestPermissions: { guestsCanInviteOthers: false }, start: { date: "2026-06-01" } }], "primary", true)[0].writable).toBe(false);
  });
  it("reads nothing from what isn't a list", () => {
    expect(eventRows(null, "primary", true)).toEqual([]);
  });
});

describe("times written to the calendar", () => {
  it("gives wall-clock times in the calendar's zone", () => {
    expect(wallTime(Date.parse("2026-06-15T08:30:00Z"), "Europe/Istanbul")).toBe("2026-06-15T11:30:00");
    expect(wallTime(Date.parse("2026-01-15T08:30:00Z"), "America/New_York")).toBe("2026-01-15T03:30:00");
  });
  it("turns days into all-day events ending the day after the last", () => {
    expect(eventTimes("2026-06-10", "Europe/Istanbul", false)).toEqual({ allDay: true, startTime: "2026-06-10T00:00:00", endTime: "2026-06-11T00:00:00", timeZone: "Europe/Istanbul" });
    expect(eventTimes("2026-06-10/2026-06-12", "UTC", true)).toMatchObject({ startTime: "2026-06-10T00:00:00", endTime: "2026-06-13T00:00:00" });
  });
  it("keeps an event's length when only a start is given, and gives a new one an hour", () => {
    expect(eventTimes("2026-06-15T08:30:00.000Z", "Europe/Istanbul", true)).toEqual({ allDay: false, startTime: "2026-06-15T11:30:00", timeZone: "Europe/Istanbul" });
    expect(eventTimes("2026-06-15T08:30:00.000Z", "Europe/Istanbul", false)).toMatchObject({ endTime: "2026-06-15T12:30:00" });
    expect(eventTimes("2026-06-15T08:30:00.000Z/2026-06-15T10:00:00.000Z", "UTC", true)).toMatchObject({ startTime: "2026-06-15T08:30:00", endTime: "2026-06-15T10:00:00" });
  });
  it("gives nothing for what isn't a date", () => {
    expect(eventTimes(null, "UTC", true)).toBeNull();
    expect(eventTimes("soon", "UTC", true)).toBeNull();
  });
});

describe("writing changes back", () => {
  const fields = { when: "w", location: "l", description: "d" };
  const target = { calendarId: "primary", timeZone: "Europe/Istanbul" };
  const event: GcalRow = {
    key: "e1",
    title: "Visit",
    summary: "Visit",
    when: "2026-06-15T08:30:00.000Z/2026-06-15T09:30:00.000Z",
    location: "Ankara",
    description: "",
    status: "confirmed",
    organizer: "",
    link: null,
    start: 0,
    writable: true,
  };

  it("writes the fields changed here that the calendar still holds, without emailing guests", () => {
    const row = { title: "Visit ETS", properties: { w: "2026-06-16T08:30:00.000Z", l: "İzmir", d: "Bring the offer" } };
    const before = { title: "Visit", w: event.when, l: "Ankara", d: null };
    expect(eventUpdate(row, before, event, fields, target)).toEqual({
      calendarId: "primary",
      notificationLevel: "NONE",
      eventId: "e1",
      summary: "Visit ETS",
      allDay: false,
      startTime: "2026-06-16T11:30:00",
      timeZone: "Europe/Istanbul",
      location: "İzmir",
      description: "Bring the offer",
    });
  });
  it("keeps the calendar's value where it changed there too", () => {
    const row = { title: "Visit", properties: { l: "İzmir" } };
    expect(eventUpdate(row, { l: "Bursa" }, event, fields, target)).toBeNull();
  });
  it("writes only fields that changed here", () => {
    const row = { title: "Renamed", properties: { l: "İzmir" } };
    expect(eventUpdate(row, { l: "Ankara" }, event, fields, target)).toEqual({ calendarId: "primary", notificationLevel: "NONE", eventId: "e1", location: "İzmir" });
  });
  it("clears a place, but never a time or a title", () => {
    const row = { title: "", properties: { w: null, l: "" } };
    const before = { title: "Visit", w: event.when, l: "Ankara" };
    expect(eventUpdate(row, before, event, fields, target)).toEqual({ calendarId: "primary", notificationLevel: "NONE", eventId: "e1", location: "" });
  });
  it("compares dates in their stored shape", () => {
    const row = { title: "Visit", properties: { w: event.when } };
    expect(eventUpdate(row, { w: "2026-06-15T08:30:00Z/2026-06-15T09:30:00Z" }, event, fields, target)).toBeNull();
  });

  it("makes an event of a new row once it has a When", () => {
    expect(eventCreate({ title: "Call", properties: {} }, fields, target)).toBeNull();
    expect(eventCreate({ title: " ", properties: { w: "2026-06-20", l: "Office" } }, fields, target, "Untitled")).toEqual({
      calendarId: "primary",
      notificationLevel: "NONE",
      summary: "Untitled",
      allDay: true,
      startTime: "2026-06-20T00:00:00",
      endTime: "2026-06-21T00:00:00",
      timeZone: "Europe/Istanbul",
      location: "Office",
    });
  });
  it("reads the new event's id from Google's answer", () => {
    expect(createdEventId({ id: "abc" })).toBe("abc");
    expect(createdEventId({ event: { id: "def" } })).toBe("def");
    expect(createdEventId({})).toBeNull();
    expect(createdEventId(null)).toBeNull();
  });
});

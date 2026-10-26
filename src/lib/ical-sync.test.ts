import { describe, expect, it } from "vitest";
import { icalUrl, icalValues, readCalendar, ENGLISH_ICAL_NAMES } from "./ical-sync";

const NOW = Date.UTC(2026, 9, 26, 12); // 2026-10-26, a Monday

const calendar = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Team", "X-WR-TIMEZONE:Europe/Istanbul", ...events, "END:VCALENDAR"].join("\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("icalUrl", () => {
  it("takes https, http and webcal addresses", () => {
    expect(icalUrl("webcal://calendar.example.test/a.ics")).toBe("https://calendar.example.test/a.ics");
    expect(icalUrl(" https://calendar.example.test/basic.ics#x ")).toBe("https://calendar.example.test/basic.ics");
    expect(icalUrl("ftp://calendar.example.test/a.ics")).toBeNull();
    expect(icalUrl("https://user:pw@calendar.example.test/a.ics")).toBeNull();
  });
});

describe("readCalendar", () => {
  it("reads events with their fields, folded lines and escapes", () => {
    const read = readCalendar(
      calendar(
        event(
          "UID:a@test",
          "SUMMARY:Planning\\, Q4",
          "DTSTART;TZID=Europe/Istanbul:20261027T100000",
          "DTEND;TZID=Europe/Istanbul:20261027T113000",
          "LOCATION:Room 1",
          "DESCRIPTION:First line\\nsecond li",
          " ne",
          "STATUS:TENTATIVE",
          'ORGANIZER;CN="Ada Lovelace":mailto:ada@example.test',
          "URL:https://meet.example.test/a",
        ),
      ),
      NOW,
    );
    expect(read?.name).toBe("Team");
    expect(read?.rows).toEqual([
      {
        key: "a@test",
        title: "Planning, Q4",
        when: "2026-10-27T07:00:00.000Z/2026-10-27T08:30:00.000Z",
        location: "Room 1",
        description: "First line\nsecond line",
        status: "tentative",
        organizer: "Ada Lovelace <ada@example.test>",
        link: "https://meet.example.test/a",
        start: Date.UTC(2026, 9, 27, 7),
      },
    ]);
  });

  it("reads whole days, their exclusive ends and durations", () => {
    const read = readCalendar(
      calendar(
        event("UID:d1", "SUMMARY:Off", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261105"),
        event("UID:d2", "SUMMARY:One day", "DTSTART;VALUE=DATE:20261103"),
        event("UID:d3", "SUMMARY:Call", "DTSTART:20261103T090000Z", "DURATION:PT45M"),
      ),
      NOW,
    );
    expect(read?.rows.map((r) => [r.key, r.when])).toEqual([
      ["d1", "2026-11-02/2026-11-04"],
      ["d2", "2026-11-03"],
      ["d3", "2026-11-03T09:00:00.000Z/2026-11-03T09:45:00.000Z"],
    ]);
  });

  it("leaves out events far from now", () => {
    const read = readCalendar(calendar(event("UID:old", "DTSTART:20200101T090000Z"), event("UID:far", "DTSTART:20300101T090000Z")), NOW);
    expect(read?.rows).toEqual([]);
  });

  it("works out weekly occurrences in the event's zone, across a change of clocks", () => {
    const read = readCalendar(
      calendar(
        event(
          "UID:standup",
          "SUMMARY:Standup",
          "DTSTART;TZID=Europe/Berlin:20261019T093000",
          "DTEND;TZID=Europe/Berlin:20261019T094500",
          "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4",
        ),
      ),
      NOW,
    );
    // Berlin leaves summer time on 2026-10-25: 07:30 UTC before, 08:30 after.
    expect(read?.rows.map((r) => r.when.split("/")[0])).toEqual([
      "2026-10-19T07:30:00.000Z",
      "2026-10-22T07:30:00.000Z",
      "2026-10-26T08:30:00.000Z",
      "2026-10-29T08:30:00.000Z",
    ]);
    expect(read?.rows[2].key).toBe("standup/2026-10-26T08:30:00.000Z");
  });

  it("skips excluded dates and follows moved and cancelled occurrences", () => {
    const read = readCalendar(
      calendar(
        event("UID:r", "SUMMARY:Review", "DTSTART:20261101T150000Z", "DTEND:20261101T160000Z", "RRULE:FREQ=DAILY;UNTIL=20261105T150000Z", "EXDATE:20261102T150000Z"),
        event("UID:r", "RECURRENCE-ID:20261103T150000Z", "SUMMARY:Review (moved)", "DTSTART:20261103T170000Z", "DTEND:20261103T180000Z"),
        event("UID:r", "RECURRENCE-ID:20261104T150000Z", "STATUS:CANCELLED", "DTSTART:20261104T150000Z"),
      ),
      NOW,
    );
    expect(read?.rows.map((r) => [r.key, r.title, r.when.split("/")[0]])).toEqual([
      ["r/2026-11-01T15:00:00.000Z", "Review", "2026-11-01T15:00:00.000Z"],
      ["r/2026-11-03T15:00:00.000Z", "Review (moved)", "2026-11-03T17:00:00.000Z"],
      ["r/2026-11-05T15:00:00.000Z", "Review", "2026-11-05T15:00:00.000Z"],
    ]);
  });

  it("repeats monthly on a weekday of the month and yearly on a day", () => {
    const read = readCalendar(
      calendar(
        event("UID:m", "DTSTART;VALUE=DATE:20261013", "RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3"),
        event("UID:y", "DTSTART;VALUE=DATE:20250415", "RRULE:FREQ=YEARLY"),
        event("UID:l", "DTSTART;VALUE=DATE:20261031", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2"),
      ),
      NOW,
    );
    const days = (uid: string) => read!.rows.filter((r) => r.key.startsWith(`${uid}/`)).map((r) => r.when);
    expect(days("m")).toEqual(["2026-10-13", "2026-11-10", "2026-12-08"]);
    expect(days("y")).toEqual(["2027-04-15"]);
    expect(days("l")).toEqual(["2026-10-31", "2026-11-30"]);
  });

  it("is null for what isn't a calendar", () => {
    expect(readCalendar("<html></html>", NOW)).toBeNull();
  });
});

describe("icalValues", () => {
  it("writes a row's fields to the mapped properties", () => {
    const [row] = readCalendar(calendar(event("UID:v", "SUMMARY:V", "DTSTART;VALUE=DATE:20261103", "STATUS:CANCELLED")), NOW)!.rows;
    expect(icalValues(row, { key: "k", when: "w", status: "s", location: "l", statuses: ENGLISH_ICAL_NAMES.statuses })).toEqual({
      k: "v",
      w: "2026-11-03",
      s: "Cancelled",
      l: null,
    });
  });
});

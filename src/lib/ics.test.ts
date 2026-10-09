import { describe, expect, it } from "vitest";
import { foldLine, icsCalendar, icsText } from "./ics";

describe("icsText", () => {
  it("escapes what the format reserves", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
});

describe("foldLine", () => {
  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });

  it("folds long lines at 75 octets without splitting characters", () => {
    const folded = foldLine(`SUMMARY:${"ş".repeat(60)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
    expect(lines.map((line, i) => (i ? line.slice(1) : line)).join("")).toBe(`SUMMARY:${"ş".repeat(60)}`);
  });
});

describe("icsCalendar", () => {
  it("writes all-day events ending the next day", () => {
    const text = icsCalendar("Tasks, Q4", [
      { uid: "row1@example.com", day: "2026-12-31", title: "Close the year", url: "https://example.com/w/1/p/row1", updatedAt: new Date("2026-10-10T08:30:00.123Z") },
    ]);
    expect(text).toContain("X-WR-CALNAME:Tasks\\, Q4\r\n");
    expect(text).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n");
    expect(text).toContain("DTSTAMP:20261010T083000Z\r\n");
    expect(text).toContain("SUMMARY:Close the year\r\n");
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("is a valid calendar without events", () => {
    expect(icsCalendar("Empty", [])).not.toContain("VEVENT");
  });
});

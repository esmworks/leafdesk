/**
 * iCalendar (RFC 5545) text for calendar feeds: all-day events, since a date property holds a day.
 * Pure: the server builds the events and serves the text (see server/calendar-feeds).
 */

export type IcsEvent = {
  /** Unique and stable for the event: the same row keeps its id across reads. */
  uid: string;
  /** The day, YYYY-MM-DD. */
  day: string;
  title: string;
  url?: string;
  /** When the event last changed. */
  updatedAt: Date;
};

/** Text escaped for a property value (RFC 5545 3.3.11). */
export function icsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds a content line to at most 75 octets per line (RFC 5545 3.1), continuation lines starting
 * with a space. Never splits a character's UTF-8 bytes.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; continuations 74 after their leading space.
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const compactDay = (day: string) => day.replaceAll("-", "");

/** The day after `day` (YYYY-MM-DD): an all-day event ends there (DTEND is exclusive). */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** A whole calendar with these events, named `name`, ready to serve as text/calendar. */
export function icsCalendar(name: string, events: IcsEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Leafdesk//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    // Calendar apps check back about this often.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(event.uid)}`,
      `DTSTAMP:${stamp(event.updatedAt)}`,
      `LAST-MODIFIED:${stamp(event.updatedAt)}`,
      `DTSTART;VALUE=DATE:${compactDay(event.day)}`,
      `DTEND;VALUE=DATE:${compactDay(nextDay(event.day))}`,
      `SUMMARY:${icsText(event.title)}`,
      ...(event.url ? [`URL:${event.url}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

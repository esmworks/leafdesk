import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatePhrase, type DatePhraseContext } from "./date-phrase";

// Saturday 10 October 2026, 10:15 in Istanbul (UTC+3).
const NOW = Date.UTC(2026, 9, 10, 7, 15, 42);
const context: DatePhraseContext = { locale: "en", timeZone: "Europe/Istanbul", now: NOW, weekStart: 1 };
const read = (text: string, more: Partial<DatePhraseContext> = {}) => parseDatePhrase(text, { ...context, ...more });
/** The day a phrase names, or "moment" / null. */
const day = (text: string, more: Partial<DatePhraseContext> = {}) => {
  const found = read(text, more);
  return found?.kind === "day" ? found.day : found ? "moment" : null;
};
/** A moment as "YYYY-MM-DD HH:MM" in Istanbul, or "day" / null. */
const at = (text: string, more: Partial<DatePhraseContext> = {}) => {
  const found = read(text, more);
  if (found?.kind !== "moment") return found ? "day" : null;
  const clock = `${String(Math.floor(found.minutes / 60)).padStart(2, "0")}:${String(found.minutes % 60).padStart(2, "0")}`;
  return `${found.day} ${clock}`;
};

describe("parseDatePhrase", () => {
  it("reads what the @ menu read before", () => {
    expect(day("today")).toBe("2026-10-10");
    expect(day("tomorrow")).toBe("2026-10-11");
    expect(day("yesterday")).toBe("2026-10-09");
    expect(day("next friday")).toBe("2026-10-16");
    expect(day("in 3 days")).toBe("2026-10-13");
    expect(day("3 days ago")).toBe("2026-10-07");
    expect(day("2026-12-01")).toBe("2026-12-01");
    expect(day("next week")).toBe("2026-10-12");
    expect(day("next month")).toBe("2026-11-01");
  });

  it("keeps reading the interface language and English beside it", () => {
    expect(day("yarın", { locale: "tr" })).toBe("2026-10-11");
    expect(day("gelecek cuma", { locale: "tr" })).toBe("2026-10-16");
    expect(day("3 gün sonra", { locale: "tr" })).toBe("2026-10-13");
    expect(day("nächsten Freitag", { locale: "de" })).toBe("2026-10-16");
    expect(day("15. Oktober", { locale: "de" })).toBe("2026-10-15");
    expect(day("昨日", { locale: "ja" })).toBe("2026-10-09");
    expect(day("tomorrow", { locale: "fr" })).toBe("2026-10-11");
  });

  it("reads weekdays and their abbreviations as the next one", () => {
    expect(day("friday")).toBe("2026-10-16");
    expect(day("fri")).toBe("2026-10-16");
    expect(day("Tues")).toBe("2026-10-13");
    expect(day("thurs")).toBe("2026-10-15");
    expect(day("sun")).toBe("2026-10-11");
    // Today is Saturday: "saturday" is a week on, never today.
    expect(day("saturday")).toBe("2026-10-17");
    expect(day("sat")).toBe("2026-10-17");
  });

  it("counts next week by the first day of the week", () => {
    // Sunday 11 October: with weeks from Monday, next week starts tomorrow; from Sunday, in a week.
    const sunday = Date.UTC(2026, 9, 11, 9);
    expect(day("next week", { now: sunday, weekStart: 1 })).toBe("2026-10-12");
    expect(day("next week", { now: sunday, weekStart: 0 })).toBe("2026-10-18");
    expect(day("next friday", { now: sunday, weekStart: 1 })).toBe("2026-10-16");
    expect(day("next friday", { now: sunday, weekStart: 0 })).toBe("2026-10-23");
    // Without one, the locale's: English weeks start on Sunday.
    expect(day("next week", { now: sunday, weekStart: undefined })).toBe("2026-10-18");
  });

  it("reads month names either side of the day, by any three or more first letters", () => {
    expect(day("aug 31")).toBe("2027-08-31");
    expect(day("august 31")).toBe("2027-08-31");
    expect(day("31 aug")).toBe("2027-08-31");
    expect(day("31 august")).toBe("2027-08-31");
    expect(day("oct 20")).toBe("2026-10-20");
    // Passed this year: next year's.
    expect(day("oct 9")).toBe("2027-10-09");
    expect(day("sept 10")).toBe("2027-09-10");
    expect(day("septem 10")).toBe("2027-09-10");
    expect(day("sep 10")).toBe("2027-09-10");
    expect(day("dece 24")).toBe("2026-12-24");
    // Two letters could be several months.
    expect(day("ju 10")).toBeNull();
    // Month first in other languages too, in a phrase.
    expect(day("ekim 20", { locale: "tr" })).toBe("2026-10-20");
    expect(day("20 eki", { locale: "tr" })).toBe("2026-10-20");
  });

  it("takes an explicit year as written and refuses days that don't exist", () => {
    expect(day("aug 31 2027")).toBe("2027-08-31");
    expect(day("aug 31, 2027")).toBe("2027-08-31");
    expect(day("31 aug 2020")).toBe("2020-08-31");
    expect(day("feb 29 2028")).toBe("2028-02-29");
    expect(day("feb 29 2027")).toBeNull();
    expect(day("feb 30")).toBeNull();
    expect(day("2026-02-30")).toBeNull();
  });

  it("reads slash dates in the language's order unless only one number can be the month", () => {
    expect(day("10/28")).toBe("2026-10-28");
    expect(day("28/10")).toBe("2026-10-28");
    expect(day("11/10")).toBe("2026-11-10");
    expect(day("11/10", { locale: "tr" })).toBe("2026-10-11");
    expect(day("10/28/2027")).toBe("2027-10-28");
    expect(day("28/10/2027")).toBe("2027-10-28");
    expect(day("2027/10/28")).toBe("2027-10-28");
    expect(day("13/13")).toBeNull();
    // A date property's own order wins over the language's.
    expect(day("11/10", { order: "dmy" })).toBe("2026-10-11");
    expect(day("11/10", { locale: "tr", order: "mdy" })).toBe("2026-11-10");
    // A year-first order doesn't guess at a pair without a year.
    expect(day("11/10", { order: "ymd" })).toBeNull();
    expect(day("10/28", { order: "ymd" })).toBe("2026-10-28");
    expect(day("15.10.2026", { locale: "de" })).toBe("2026-10-15");
  });

  it("refuses two-digit years, bare numbers and words it doesn't know", () => {
    expect(read("10/28/27")).toBeNull();
    expect(read("15.10.26", { locale: "de" })).toBeNull();
    expect(read("31")).toBeNull();
    expect(read("9")).toBeNull();
    expect(read("")).toBeNull();
    expect(read("   ")).toBeNull();
    expect(read("call mom")).toBeNull();
    expect(read("friday meeting")).toBeNull();
    expect(read("end of month")).toBeNull();
  });

  it("adds a time of day to a date", () => {
    expect(at("friday 5pm")).toBe("2026-10-16 17:00");
    expect(at("tomorrow 9am")).toBe("2026-10-11 09:00");
    expect(at("tomorrow 9:30pm")).toBe("2026-10-11 21:30");
    expect(at("tomorrow 17:30")).toBe("2026-10-11 17:30");
    expect(at("aug 31 at 9 pm")).toBe("2027-08-31 21:00");
    expect(at("aug 31, 2027 at 9am")).toBe("2027-08-31 09:00");
    expect(at("friday 5 pm")).toBe("2026-10-16 17:00");
    expect(at("tomorrow 5 p.m.")).toBe("2026-10-11 17:00");
    expect(at("tomorrow 12am")).toBe("2026-10-11 00:00");
    expect(at("tomorrow 12pm")).toBe("2026-10-11 12:00");
    expect(at("10/28 5pm")).toBe("2026-10-28 17:00");
    expect(at("2026-10-28T17:30")).toBe("2026-10-28 17:30");
    expect(at("17:30 tomorrow")).toBe("2026-10-11 17:30");
    expect(at("yarın saat 17:30", { locale: "tr" })).toBe("2026-10-11 17:30");
    expect(at("morgen um 9:00", { locale: "de" })).toBe("2026-10-11 09:00");
  });

  it("gives the instant in the person's time zone", () => {
    expect(read("tomorrow 9am")).toEqual({ kind: "moment", day: "2026-10-11", minutes: 540, at: "2026-10-11T06:00:00.000Z" });
    expect(read("tomorrow 9am", { timeZone: "America/New_York" })).toMatchObject({ at: "2026-10-11T13:00:00.000Z" });
    // New York's 10 October is still going at 07:15 UTC.
    expect(day("today", { timeZone: "America/New_York" })).toBe("2026-10-10");
    expect(day("today", { timeZone: "Pacific/Kiritimati" })).toBe("2026-10-10");
    expect(day("today", { timeZone: "Pacific/Pago_Pago" })).toBe("2026-10-09");
  });

  it("reads a time on its own as today, or tomorrow once it has gone by", () => {
    expect(at("5pm")).toBe("2026-10-10 17:00");
    expect(at("9am")).toBe("2026-10-11 09:00");
    expect(at("10:15")).toBe("2026-10-11 10:15");
    expect(at("10:16")).toBe("2026-10-10 10:16");
    expect(at("at 5pm")).toBe("2026-10-10 17:00");
    expect(at("5 pm")).toBe("2026-10-10 17:00");
  });

  it("refuses clocks that aren't", () => {
    expect(read("13pm")).toBeNull();
    expect(read("0am")).toBeNull();
    expect(read("24:00")).toBeNull();
    expect(read("17:60")).toBeNull();
    expect(read("tomorrow 5")).toBeNull();
    expect(read("in 5pm")).toBeNull();
  });

  it("reads minutes and hours as moments from now", () => {
    expect(at("30m")).toBe("2026-10-10 10:45");
    expect(at("in 30m")).toBe("2026-10-10 10:45");
    expect(at("30 mins")).toBe("2026-10-10 10:45");
    expect(at("4h")).toBe("2026-10-10 14:15");
    expect(at("in 4 hours")).toBe("2026-10-10 14:15");
    expect(at("14h")).toBe("2026-10-11 00:15");
    expect(read("in 30m")).toMatchObject({ at: "2026-10-10T07:45:00.000Z" });
  });

  it("reads days, weeks and months as days", () => {
    expect(day("3d")).toBe("2026-10-13");
    expect(day("in 3d")).toBe("2026-10-13");
    expect(day("3 days")).toBe("2026-10-13");
    expect(day("2w")).toBe("2026-10-24");
    expect(day("2 weeks")).toBe("2026-10-24");
    expect(day("in 2 wks")).toBe("2026-10-24");
    expect(day("2mo")).toBe("2026-12-10");
    expect(day("in 1 month")).toBe("2026-11-10");
    // Months keep the day where the month has it.
    expect(day("1mo", { now: Date.UTC(2027, 0, 31, 9) })).toBe("2027-02-28");
    expect(day("1 month", { now: Date.UTC(2028, 0, 31, 9) })).toBe("2028-02-29");
    expect(at("3d 5pm")).toBe("2026-10-13 17:00");
  });

  it("counts signed durations from the reference day", () => {
    expect(day("+2w")).toBe("2026-10-24");
    expect(day("-3d")).toBe("2026-10-07");
    expect(day("+2w", { reference: "2026-11-01" })).toBe("2026-11-15");
    expect(day("-1w", { reference: "2026-11-01" })).toBe("2026-10-25");
    expect(day("+1mo", { reference: "2026-01-31" })).toBe("2026-02-28");
    // Unsigned ones still count from now.
    expect(day("2w", { reference: "2026-11-01" })).toBe("2026-10-24");
    // Hours from the reference day at this time of day; from now when it is today.
    expect(at("+4h", { reference: "2026-11-01" })).toBe("2026-11-01 14:15");
    expect(at("+4h")).toBe("2026-10-10 14:15");
    expect(at("-30m", { reference: "2026-11-01" })).toBe("2026-11-01 09:45");
    expect(at("+2d 9am", { reference: "2026-11-01" })).toBe("2026-11-03 09:00");
  });

  it("refuses a sign with in, or a sign on anything but a duration", () => {
    expect(read("in +2w")).toBeNull();
    expect(read("in -3d")).toBeNull();
    expect(read("+3")).toBeNull();
    expect(read("-friday")).toBeNull();
    expect(read("+2x")).toBeNull();
  });
});

describe("the examples the boxes show", () => {
  const messages = join(__dirname, "../i18n/messages");
  const locales = readdirSync(messages).filter((name) => !name.includes("."));
  // "Type a date: fri 5pm, aug 31, +2w" → ["fri 5pm", "aug 31", "+2w"].
  const examples = (text: string) =>
    text
      .replace(/^[^:：]*[:：]\s*/, "")
      .split(/\s*[,،、]\s*/)
      .filter(Boolean);

  it.each(locales)("are dates in %s", (locale) => {
    const common = JSON.parse(readFileSync(join(messages, locale, "common.json"), "utf8"));
    const page = JSON.parse(readFileSync(join(messages, locale, "page.json"), "utf8"));
    const written = [...examples(common.datePhrase.placeholder), ...examples(page.mention.remindAtPlaceholder)];
    expect(written.length).toBeGreaterThan(2);
    for (const text of written) expect({ text, found: read(text, { locale }) !== null }).toEqual({ text, found: true });
  });
});

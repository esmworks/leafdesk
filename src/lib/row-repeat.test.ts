import { describe, expect, it } from "vitest";
import { nextRepeatValue, parseRowRepeatRule, presetOf, repeatPresets, skippedRepeatValue, type RowRepeatRule } from "./row-repeat";

const rule = (r: Partial<RowRepeatRule>): RowRepeatRule => ({
  frequency: "daily",
  interval: 1,
  weekdays: [],
  from: "due",
  anchor: "2026-11-02",
  until: null,
  ...r,
});

const UTC = "UTC";
// 2026-11-02 is a Monday.

describe("parseRowRepeatRule", () => {
  it("fills in what may be left out", () => {
    expect(parseRowRepeatRule({ frequency: "weekly" }, "2026-11-04")).toEqual(
      rule({ frequency: "weekly", weekdays: [3], anchor: "2026-11-04" }),
    );
    expect(parseRowRepeatRule({ frequency: "monthly", interval: 3, from: "done" }, "2026-11-04")).toEqual(
      rule({ frequency: "monthly", interval: 3, from: "done", anchor: "2026-11-04" }),
    );
  });

  it("drops weekdays where they mean nothing", () => {
    expect(parseRowRepeatRule({ frequency: "weekly", weekdays: [1, 3], from: "done", anchor: "2026-11-02" })?.weekdays).toEqual([]);
    expect(parseRowRepeatRule({ frequency: "daily", weekdays: [1], anchor: "2026-11-02" })?.weekdays).toEqual([]);
  });

  it("refuses what isn't a rule", () => {
    for (const bad of [
      null,
      [],
      { frequency: "hourly", anchor: "2026-11-02" },
      { frequency: "daily", interval: 0, anchor: "2026-11-02" },
      { frequency: "daily", interval: 100, anchor: "2026-11-02" },
      { frequency: "daily", interval: 1.5, anchor: "2026-11-02" },
      { frequency: "daily", from: "start", anchor: "2026-11-02" },
      { frequency: "daily" },
      { frequency: "daily", anchor: "2026-02-30" },
      { frequency: "daily", anchor: "2026-11-02", until: "soon" },
      { frequency: "weekly", weekdays: [], anchor: "2026-11-02" },
      { frequency: "weekly", weekdays: [7], anchor: "2026-11-02" },
    ]) {
      expect(parseRowRepeatRule(bad)).toBeNull();
    }
  });
});

describe("nextRepeatValue counted from the date", () => {
  it("moves a day to the next time", () => {
    expect(nextRepeatValue(rule({}), "2026-11-02", "2026-11-02", "2026-11-02", UTC)).toBe("2026-11-03");
    expect(nextRepeatValue(rule({ interval: 3 }), "2026-11-02", "2026-11-02", "2026-11-02", UTC)).toBe("2026-11-05");
  });

  it("gives one copy for a row done late, not one per time it missed", () => {
    // Due Monday the 2nd, every 3 days, done on Wednesday the 11th: the 2nd, 5th, 8th went by.
    expect(nextRepeatValue(rule({ interval: 3 }), "2026-11-02", "2026-11-11", "2026-11-11", UTC)).toBe("2026-11-11");
    expect(nextRepeatValue(rule({ frequency: "monthly", anchor: "2026-01-15" }), "2026-01-15", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-15");
  });

  it("goes round the chosen weekdays", () => {
    const workdays = rule({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5] });
    expect(nextRepeatValue(workdays, "2026-11-06", "2026-11-06", "2026-11-06", UTC)).toBe("2026-11-09");
    const mondayWednesday = rule({ frequency: "weekly", weekdays: [1, 3] });
    expect(nextRepeatValue(mondayWednesday, "2026-11-02", "2026-11-02", "2026-11-02", UTC)).toBe("2026-11-04");
    expect(nextRepeatValue(mondayWednesday, "2026-11-04", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-09");
  });

  it("skips weeks for every other week", () => {
    const fortnightly = rule({ frequency: "weekly", interval: 2, weekdays: [1, 3] });
    expect(nextRepeatValue(fortnightly, "2026-11-02", "2026-11-02", "2026-11-02", UTC)).toBe("2026-11-04");
    expect(nextRepeatValue(fortnightly, "2026-11-04", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-16");
    // Done a month late, on Tuesday the 8th of December, a week the rule skips: its next week.
    expect(nextRepeatValue(fortnightly, "2026-11-04", "2026-12-08", "2026-12-08", UTC)).toBe("2026-12-14");
    expect(nextRepeatValue(fortnightly, "2026-11-04", "2026-12-01", "2026-12-01", UTC)).toBe("2026-12-02");
  });

  it("keeps the day of the month it was set on through shorter months", () => {
    const monthly = rule({ frequency: "monthly", anchor: "2026-01-31" });
    expect(nextRepeatValue(monthly, "2026-01-31", "2026-01-31", "2026-01-31", UTC)).toBe("2026-02-28");
    expect(nextRepeatValue(monthly, "2026-02-28", "2026-02-28", "2026-02-28", UTC)).toBe("2026-03-31");
    expect(nextRepeatValue(rule({ frequency: "monthly", interval: 3, anchor: "2026-11-30" }), "2026-11-30", "2026-11-30", "2026-11-30", UTC)).toBe(
      "2027-02-28",
    );
  });

  it("comes round yearly, the 29th of February on the 28th in other years", () => {
    const leap = rule({ frequency: "yearly", anchor: "2028-02-29" });
    expect(nextRepeatValue(leap, "2028-02-29", "2028-02-29", "2028-02-29", UTC)).toBe("2029-02-28");
    expect(nextRepeatValue(leap, "2031-02-28", "2031-02-28", "2031-02-28", UTC)).toBe("2032-02-29");
  });

  it("keeps a range's length and a time's clock", () => {
    expect(nextRepeatValue(rule({ frequency: "weekly", weekdays: [1] }), "2026-11-02/2026-11-04", "2026-11-03", "2026-11-03", UTC)).toBe(
      "2026-11-09/2026-11-11",
    );
    // 09:00 in Berlin on both sides of the change of clocks (2026-10-25).
    expect(nextRepeatValue(rule({ frequency: "weekly", weekdays: [1] }), "2026-10-19T07:00:00.000Z", "2026-10-19", "2026-10-19", "Europe/Berlin")).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("starts from the day it was done when the row had no date", () => {
    expect(nextRepeatValue(rule({ interval: 2 }), null, "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-06");
  });

  it("ends after until", () => {
    const ending = rule({ until: "2026-11-05" });
    expect(nextRepeatValue(ending, "2026-11-04", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-05");
    expect(nextRepeatValue(ending, "2026-11-05", "2026-11-05", "2026-11-05", UTC)).toBeNull();
  });
});

describe("nextRepeatValue counted from the day it was done", () => {
  it("adds the interval to the day it was done", () => {
    const done = rule({ interval: 10, from: "done" });
    expect(nextRepeatValue(done, "2026-11-02", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-14");
    expect(nextRepeatValue(rule({ frequency: "weekly", interval: 2, from: "done" }), "2026-11-02", "2026-11-04", "2026-11-04", UTC)).toBe("2026-11-18");
    expect(nextRepeatValue(rule({ frequency: "monthly", interval: 3, from: "done" }), "2026-08-01", "2026-11-30", "2026-11-30", UTC)).toBe("2027-02-28");
  });

  it("keeps the time of day", () => {
    expect(nextRepeatValue(rule({ interval: 3, from: "done" }), "2026-11-02T10:30:00.000Z", "2026-11-04", "2026-11-04", UTC)).toBe(
      "2026-11-07T10:30:00.000Z",
    );
  });
});

describe("skippedRepeatValue", () => {
  it("moves the date to where its copy would go", () => {
    expect(skippedRepeatValue(rule({ frequency: "weekly", weekdays: [1] }), "2026-11-02", "2026-11-02", UTC)).toBe("2026-11-09");
    expect(skippedRepeatValue(rule({ interval: 5, from: "done" }), "2026-11-02", "2026-11-04", UTC)).toBe("2026-11-09");
  });
});

describe("repeatPresets", () => {
  it("offers rules on the date's own weekday and day", () => {
    const presets = repeatPresets("2026-11-04");
    expect(presets.map((p) => p.key)).toEqual(["daily", "workdays", "weekly", "monthly", "yearly"]);
    expect(presets.find((p) => p.key === "weekly")?.rule.weekdays).toEqual([3]);
    for (const p of presets) expect(presetOf(p.rule)).toBe(p.key);
    expect(presetOf(rule({ interval: 2, anchor: "2026-11-04" }))).toBeNull();
    // As Postgres gives a stored rule back: the same fields in another order.
    expect(presetOf(JSON.parse('{"from":"due","until":null,"anchor":"2026-11-04","interval":1,"weekdays":[3],"frequency":"weekly"}'))).toBe("weekly");
  });
});

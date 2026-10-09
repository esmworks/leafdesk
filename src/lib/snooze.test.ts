import { describe, expect, it } from "vitest";
import { snoozeUntil } from "./snooze";

describe("snoozeUntil", () => {
  // Saturday 10 October 2026, 14:30 local time.
  const saturday = new Date(2026, 9, 10, 14, 30);

  it("snoozes for an hour", () => {
    expect(snoozeUntil("hour", saturday).getTime() - saturday.getTime()).toBe(3_600_000);
  });

  it("brings it back tomorrow at 9:00", () => {
    expect(snoozeUntil("tomorrow", saturday)).toEqual(new Date(2026, 9, 11, 9));
  });

  it("brings it back next Monday at 9:00, a week on from a Monday", () => {
    expect(snoozeUntil("nextWeek", saturday)).toEqual(new Date(2026, 9, 12, 9));
    expect(snoozeUntil("nextWeek", new Date(2026, 9, 12, 8))).toEqual(new Date(2026, 9, 19, 9));
    expect(snoozeUntil("nextWeek", new Date(2026, 9, 11, 23))).toEqual(new Date(2026, 9, 12, 9));
  });
});

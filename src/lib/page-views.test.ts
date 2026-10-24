import { describe, expect, it } from "vitest";
import { dailySeries, firstViewDay, oldestKeptViewDay, shouldSendView, VIEW_REPEAT_MS, viewDay } from "./page-views";

const now = new Date("2026-10-24T09:30:00Z");

describe("viewDay", () => {
  it("is the UTC day", () => {
    expect(viewDay(now)).toBe("2026-10-24");
    expect(viewDay(new Date("2026-10-24T23:59:59-05:00"))).toBe("2026-10-25");
  });
});

describe("firstViewDay", () => {
  it("counts today as the period's last day", () => {
    expect(firstViewDay(now, 1)).toBe("2026-10-24");
    expect(firstViewDay(now, 7)).toBe("2026-10-18");
    expect(firstViewDay(now, 30)).toBe("2026-09-25");
  });

  it("keeps a year of views", () => {
    expect(oldestKeptViewDay(now)).toBe("2025-10-25");
  });
});

describe("shouldSendView", () => {
  it("sends the first view of a page", () => {
    expect(shouldSendView(undefined, 1_000)).toBe(true);
  });

  it("doesn't send the same page again until the repeat window has passed", () => {
    const sent = 1_000_000;
    expect(shouldSendView(sent, sent + 1)).toBe(false);
    expect(shouldSendView(sent, sent + VIEW_REPEAT_MS - 1)).toBe(false);
    expect(shouldSendView(sent, sent + VIEW_REPEAT_MS)).toBe(true);
  });

  it("sends again when the clock went back", () => {
    expect(shouldSendView(2_000_000, 1_000_000)).toBe(true);
  });
});

describe("dailySeries", () => {
  it("has one entry per day of the period, oldest first, with days without views as 0", () => {
    const series = dailySeries(
      [
        { day: "2026-10-24", views: 3 },
        { day: "2026-10-20", views: 1 },
      ],
      now,
      7,
    );
    expect(series).toEqual([
      { day: "2026-10-18", views: 0 },
      { day: "2026-10-19", views: 0 },
      { day: "2026-10-20", views: 1 },
      { day: "2026-10-21", views: 0 },
      { day: "2026-10-22", views: 0 },
      { day: "2026-10-23", views: 0 },
      { day: "2026-10-24", views: 3 },
    ]);
  });

  it("adds up rows of the same day and leaves out days outside the period", () => {
    const series = dailySeries(
      [
        { day: "2026-10-23", views: 2 },
        { day: "2026-10-23", views: 5 },
        { day: "2026-09-01", views: 9 },
      ],
      now,
      7,
    );
    expect(series.find((d) => d.day === "2026-10-23")?.views).toBe(7);
    expect(series.reduce((sum, d) => sum + d.views, 0)).toBe(7);
  });

  it("spans 90 days across month ends", () => {
    const series = dailySeries([], now, 90);
    expect(series).toHaveLength(90);
    expect(series[0].day).toBe("2026-07-27");
    expect(series.at(-1)?.day).toBe("2026-10-24");
  });
});

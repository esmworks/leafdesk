import { describe, expect, it } from "vitest";
import { workBlockItem } from "./calendar-items";
import {
  hoursAndMinutes,
  matchesTaskFilter,
  plannedMinutes,
  resizedEnd,
  snapMinutes,
  sortTasksToPlan,
  workBlockLengthError,
  workTaskKey,
  workTaskRef,
} from "./work-blocks";

const at = (iso: string) => Date.parse(iso);

describe("work blocks", () => {
  it("allows 15 minutes to 12 hours", () => {
    expect(workBlockLengthError(at("2026-11-10T10:00:00Z"), at("2026-11-10T10:15:00Z"))).toBeNull();
    expect(workBlockLengthError(at("2026-11-10T10:00:00Z"), at("2026-11-10T10:14:00Z"))).toBe("tooShort");
    expect(workBlockLengthError(at("2026-11-10T10:00:00Z"), at("2026-11-10T09:00:00Z"))).toBe("tooShort");
    expect(workBlockLengthError(at("2026-11-10T10:00:00Z"), at("2026-11-10T22:00:00Z"))).toBeNull();
    expect(workBlockLengthError(at("2026-11-10T10:00:00Z"), at("2026-11-10T22:01:00Z"))).toBe("tooLong");
    // Across midnight is fine.
    expect(workBlockLengthError(at("2026-11-10T23:00:00Z"), at("2026-11-11T01:00:00Z"))).toBeNull();
    expect(workBlockLengthError(Number.NaN, 0)).toBe("invalid");
  });

  it("snaps to 15 minutes", () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(52)).toBe(45);
    expect(snapMinutes(53)).toBe(60);
  });

  it("keeps a resized block within its limits and its day", () => {
    expect(resizedEnd(600, 683)).toBe(690);
    expect(resizedEnd(600, 590)).toBe(615);
    expect(resizedEnd(60, 1400)).toBe(60 + 720);
    expect(resizedEnd(1380, 1500)).toBe(1440);
  });

  it("adds up the time planned per task", () => {
    const totals = plannedMinutes([
      { pageId: "row", blockId: null, startsAt: new Date("2026-11-10T10:00:00Z"), endsAt: new Date("2026-11-10T12:00:00Z") },
      { pageId: "row", blockId: null, startsAt: new Date("2026-11-12T14:00:00Z"), endsAt: new Date("2026-11-12T14:30:00Z") },
      { pageId: "page", blockId: "b1", startsAt: new Date("2026-11-10T09:00:00Z"), endsAt: new Date("2026-11-10T09:45:00Z") },
    ]);
    expect(totals.get("row")).toBe(150);
    expect(totals.get("page:b1")).toBe(45);
    expect(totals.size).toBe(2);
    expect(hoursAndMinutes(150)).toEqual({ hours: 2, minutes: 30 });
    expect(hoursAndMinutes(45)).toEqual({ hours: 0, minutes: 45 });
  });

  it("names tasks as My tasks does", () => {
    expect(workTaskKey("row", null)).toBe("row");
    expect(workTaskKey("page", "b1")).toBe("page:b1");
    expect(workTaskRef("row", null)).toEqual({ type: "row", rowId: "row" });
    expect(workTaskRef("page", "b1")).toEqual({ type: "pageTask", pageId: "page", blockId: "b1" });
  });

  it("sorts by due date, undated last, then by title, and filters by words", () => {
    const tasks = [
      { title: "Beta", date: null, detail: null },
      { title: "Zed", date: "2026-11-10", detail: "Offers" },
      { title: "Alpha", date: "2026-11-12", detail: null },
      { title: "Able", date: "2026-11-10", detail: null },
      { title: "Aaron", date: null, detail: null },
    ];
    expect(sortTasksToPlan(tasks, new Intl.Collator("en")).map((t) => t.title)).toEqual(["Able", "Zed", "Alpha", "Aaron", "Beta"]);
    expect(matchesTaskFilter(tasks[1], "zed off")).toBe(true);
    expect(matchesTaskFilter(tasks[1], "zed alpha")).toBe(false);
    expect(matchesTaskFilter(tasks[0], "  ")).toBe(true);
  });

  it("is a calendar item that never becomes whole days", () => {
    const item = workBlockItem({
      id: "b",
      startsAt: new Date("2026-11-10T10:00:00Z"),
      endsAt: new Date("2026-11-10T11:00:00Z"),
      title: "Offer",
      icon: null,
      href: "/w/ws/p/row",
      detail: "Tasks",
      done: true,
      ref: { type: "row", rowId: "row" },
      markable: true,
    });
    expect(item).toMatchObject({ id: "block:b", kind: "block", date: "2026-11-10T10:00:00.000Z/2026-11-10T11:00:00.000Z", moves: { allDay: false }, done: true });
    // Done already: nothing to mark.
    expect(item.task).toEqual({ ref: { type: "row", rowId: "row" }, markable: false });
  });
});

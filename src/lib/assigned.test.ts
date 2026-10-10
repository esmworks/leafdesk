import { describe, expect, it } from "vitest";
import { assignedGroup, groupAssigned } from "./assigned";

describe("assignedGroup", () => {
  const today = "2026-10-09";

  it("puts a row by its date relative to today", () => {
    expect(assignedGroup("2026-10-08", today)).toBe("overdue");
    expect(assignedGroup("2025-12-31", today)).toBe("overdue");
    expect(assignedGroup("2026-10-09", today)).toBe("today");
    expect(assignedGroup("2026-10-10", today)).toBe("next7");
    expect(assignedGroup("2026-10-16", today)).toBe("next7");
    expect(assignedGroup("2026-10-17", today)).toBe("later");
  });

  it("is due today while today is within a range, and overdue once it ended", () => {
    expect(assignedGroup("2026-10-07", today, "2026-10-11")).toBe("today");
    expect(assignedGroup("2026-10-05", today, "2026-10-08")).toBe("overdue");
    expect(assignedGroup("2026-10-12", today, "2026-10-20")).toBe("next7");
  });

  it("counts across months and years", () => {
    expect(assignedGroup("2027-01-02", "2026-12-31")).toBe("next7");
    expect(assignedGroup("2026-02-28", "2026-03-01")).toBe("overdue");
  });

  it("treats a missing or malformed date as none", () => {
    expect(assignedGroup(null, today)).toBe("none");
    expect(assignedGroup("", today)).toBe("none");
    expect(assignedGroup("tomorrow", today)).toBe("none");
  });
});

describe("groupAssigned", () => {
  const at = (iso: string) => new Date(iso);

  it("orders groups, drops empty ones and sorts by date, then last edited", () => {
    const rows = [
      { id: "a", date: null, updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "b", date: "2026-10-12", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "c", date: "2026-10-05", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "d", date: "2026-10-11", updatedAt: at("2026-10-01T00:00:00Z") },
      { id: "e", date: null, updatedAt: at("2026-10-08T00:00:00Z") },
      { id: "f", date: "2026-10-11", updatedAt: at("2026-10-07T00:00:00Z") },
    ];
    const groups = groupAssigned(rows, "2026-10-09");
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["overdue", ["c"]],
      ["next7", ["f", "d", "b"]],
      ["none", ["e", "a"]],
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(groupAssigned([], "2026-10-09")).toEqual([]);
  });
});

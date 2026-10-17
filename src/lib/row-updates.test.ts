import { describe, expect, it } from "vitest";
import {
  isEmptyRowUpdate,
  mergeRowUpdates,
  parseRowUpdate,
  ROW_UPDATE_IDLE_MS,
  ROW_UPDATE_MAX_WAIT_MS,
  rowUpdateDueAt,
  visibleRowUpdate,
  type RowUpdate,
} from "./row-updates";

const status = (from: unknown, to: unknown) => ({ propertyId: "status", propertyType: "status" as const, from, to });
const due = (from: unknown, to: unknown) => ({ propertyId: "due", propertyType: "date" as const, from, to });
const title = (from: string, to: string) => ({ propertyId: null, propertyType: null, from, to });
const update = (changes: RowUpdate["changes"], body = false): RowUpdate => ({ changes, body });

describe("mergeRowUpdates", () => {
  it("keeps where each value started and where it ended up", () => {
    const merged = mergeRowUpdates(update([status("todo", "doing")]), update([status("doing", "done")]));
    expect(merged).toEqual(update([status("todo", "done")]));
  });

  it("drops a value changed back to where it started", () => {
    const merged = mergeRowUpdates(update([status("todo", "doing"), due(null, "2026-10-20")]), update([status("doing", "todo")]));
    expect(merged).toEqual(update([due(null, "2026-10-20")]));
    expect(isEmptyRowUpdate(mergeRowUpdates(update([status("todo", "doing")]), update([status("doing", "todo")])))).toBe(true);
  });

  it("counts nothing the same however it is written", () => {
    // Clearing a list value back to empty, after it started out unset.
    const merged = mergeRowUpdates(update([{ propertyId: "tags", propertyType: "multi_select", from: undefined, to: ["a"] }]), update([{ propertyId: "tags", propertyType: "multi_select", from: ["a"], to: [] }]));
    expect(merged.changes).toEqual([]);
  });

  it("lists values in the order they were first changed, the title among them", () => {
    const merged = mergeRowUpdates(update([due(null, "2026-10-20"), title("Draft", "Plan")]), update([status("todo", "done"), due("2026-10-20", "2026-10-21")]));
    expect(merged.changes.map((c) => c.propertyId)).toEqual(["due", null, "status"]);
    expect(merged.changes[0]).toEqual(due(null, "2026-10-21"));
  });

  it("remembers that the body changed", () => {
    expect(mergeRowUpdates(update([], true), update([status("todo", "done")])).body).toBe(true);
    expect(mergeRowUpdates(update([status("todo", "done")]), update([], true))).toEqual(update([status("todo", "done")], true));
    // The body has no before and after to compare: once edited, it stays news.
    expect(isEmptyRowUpdate(mergeRowUpdates(update([status("a", "b")], true), update([status("b", "a")])))).toBe(false);
  });

  it("reads a value with the type it was last written as", () => {
    const merged = mergeRowUpdates(update([{ propertyId: "p", propertyType: "text", from: "1", to: "2" }]), update([{ propertyId: "p", propertyType: "number", from: 2, to: 3 }]));
    expect(merged.changes).toEqual([{ propertyId: "p", propertyType: "number", from: "1", to: 3 }]);
  });
});

describe("rowUpdateDueAt", () => {
  const first = new Date("2026-10-17T10:00:00Z");

  it("waits a while after the latest change", () => {
    expect(rowUpdateDueAt(first, first).getTime()).toBe(first.getTime() + ROW_UPDATE_IDLE_MS);
    const later = new Date(first.getTime() + 3 * 60_000);
    expect(rowUpdateDueAt(first, later).getTime()).toBe(later.getTime() + ROW_UPDATE_IDLE_MS);
  });

  it("goes out at last however long the edits keep coming", () => {
    const busy = new Date(first.getTime() + ROW_UPDATE_MAX_WAIT_MS - 10_000);
    expect(rowUpdateDueAt(first, busy).getTime()).toBe(first.getTime() + ROW_UPDATE_MAX_WAIT_MS);
    const long = new Date(first.getTime() + 2 * ROW_UPDATE_MAX_WAIT_MS);
    expect(rowUpdateDueAt(first, long).getTime()).toBe(first.getTime() + ROW_UPDATE_MAX_WAIT_MS);
  });
});

describe("visibleRowUpdate", () => {
  it("leaves out properties the viewer may not see, never the title or body", () => {
    const all = update([status("todo", "done"), due(null, "2026-10-20"), title("Draft", "Plan")], true);
    expect(visibleRowUpdate(all, new Set(["status"]))).toEqual(update([status("todo", "done"), title("Draft", "Plan")], true));
    expect(isEmptyRowUpdate(visibleRowUpdate(update([due(null, "2026-10-20")]), new Set()))).toBe(true);
  });
});

describe("parseRowUpdate", () => {
  it("reads stored updates and nothing else", () => {
    expect(parseRowUpdate({ changes: [status("a", "b")], body: true })).toEqual(update([status("a", "b")], true));
    expect(parseRowUpdate(null)).toEqual(update([]));
    expect(parseRowUpdate({ changes: [{ propertyId: 5 }, "x", title("a", "b")], body: "yes" })).toEqual(update([title("a", "b")]));
  });
});

import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./keep-unchanged";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Row ${id}`,
  icon: null,
  properties: { status: "todo", tags: ["a", "b"] },
  createdAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-02T10:00:00Z"),
  position: Number(id),
  ...extra,
});

const snapshot = () => ({
  database: { id: "db", title: "Tasks", locked: false },
  properties: [
    { id: "status", name: "Status", options: { options: [{ id: "todo", name: "To do" }] } },
    { id: "tags", name: "Tags", options: {} },
  ],
  rows: [row("1"), row("2"), row("3")],
  relations: { rel: { database: { id: "other" }, rows: [{ id: "x", title: "X" }] } },
  people: [],
});

describe("keepUnchanged", () => {
  it("returns the previous value when nothing changed", () => {
    const prev = snapshot();
    expect(keepUnchanged(prev, snapshot())).toBe(prev);
  });

  it("gives only the changed row a new object", () => {
    const prev = snapshot();
    const next = snapshot();
    next.rows[1] = row("2", { title: "Renamed" });
    const kept = keepUnchanged(prev, next);
    expect(kept).not.toBe(prev);
    expect(kept.rows).not.toBe(prev.rows);
    expect(kept.rows[0]).toBe(prev.rows[0]);
    expect(kept.rows[1]).not.toBe(prev.rows[1]);
    expect(kept.rows[1].title).toBe("Renamed");
    // Its unchanged parts are kept too.
    expect(kept.rows[1].properties).toBe(prev.rows[1].properties);
    expect(kept.rows[2]).toBe(prev.rows[2]);
    expect(kept.properties).toBe(prev.properties);
    expect(kept.relations).toBe(prev.relations);
    expect(kept.database).toBe(prev.database);
  });

  it("compares dates by time", () => {
    const prev = snapshot();
    const next = snapshot();
    expect(next.rows[0].updatedAt).not.toBe(prev.rows[0].updatedAt);
    expect(keepUnchanged(prev, next).rows[0]).toBe(prev.rows[0]);
    next.rows[0] = row("1", { updatedAt: new Date("2026-10-03T10:00:00Z") });
    const kept = keepUnchanged(prev, next);
    expect(kept.rows[0]).not.toBe(prev.rows[0]);
    expect(kept.rows[0].updatedAt.getTime()).toBe(new Date("2026-10-03T10:00:00Z").getTime());
  });

  it("matches rows by id when they moved, came or went", () => {
    const prev = snapshot();
    const moved = keepUnchanged(prev, { ...snapshot(), rows: [row("3"), row("1"), row("2")] });
    expect(moved.rows.map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(moved.rows[0]).toBe(prev.rows[2]);
    expect(moved.rows[1]).toBe(prev.rows[0]);
    expect(moved.rows[2]).toBe(prev.rows[1]);

    const added = keepUnchanged(prev, { ...snapshot(), rows: [row("1"), row("4"), row("2"), row("3")] });
    expect(added.rows.map((r) => r.id)).toEqual(["1", "4", "2", "3"]);
    expect(added.rows[0]).toBe(prev.rows[0]);
    expect(added.rows[2]).toBe(prev.rows[1]);

    const removed = keepUnchanged(prev, { ...snapshot(), rows: [row("1"), row("3")] });
    expect(removed.rows).toHaveLength(2);
    expect(removed.rows[1]).toBe(prev.rows[2]);
  });

  it("notices a key that came or went, also one set to undefined", () => {
    const prev = { a: 1, b: undefined as number | undefined };
    expect(keepUnchanged(prev, { a: 1, b: undefined })).toBe(prev);
    const withoutB = keepUnchanged<Record<string, unknown>>(prev, { a: 1 });
    expect(withoutB).not.toBe(prev);
    expect(Object.keys(withoutB)).toEqual(["a"]);
    const withC = keepUnchanged<Record<string, unknown>>({ a: 1 }, { a: 1, c: undefined });
    expect(Object.keys(withC)).toEqual(["a", "c"]);
  });

  it("notices a changed value deep inside, and a value whose type changed", () => {
    const prev = snapshot();
    const next = snapshot();
    next.rows[0].properties.tags = ["a", "c"];
    const kept = keepUnchanged(prev, next);
    expect(kept.rows[0].properties.tags).toEqual(["a", "c"]);
    expect(kept.rows[0].properties).not.toBe(prev.rows[0].properties);
    expect(kept.rows[1]).toBe(prev.rows[1]);

    const typed = keepUnchanged<Record<string, unknown>>({ v: [1] }, { v: { 0: 1 } });
    expect(typed.v).toEqual({ 0: 1 });
    expect(keepUnchanged<unknown>(new Date(0), "1970-01-01")).toBe("1970-01-01");
  });

  it("keeps items without an id by index", () => {
    const prev = [{ name: "a" }, { name: "b" }];
    const kept = keepUnchanged(prev, [{ name: "a" }, { name: "c" }]);
    expect(kept[0]).toBe(prev[0]);
    expect(kept[1]).toEqual({ name: "c" });
  });
});

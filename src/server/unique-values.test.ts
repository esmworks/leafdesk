import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  props: [] as { id: string; type: string }[],
  found: [] as { ord: string; key: string | null; held_by: string | null }[][],
  executed: 0,
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.props }) }),
    execute: async () => {
      state.executed++;
      return state.found.shift() ?? [];
    },
  },
}));

const { dropRepeatedValues, uniqueViolation } = await import("./unique-values");

beforeEach(() => {
  state.props = [];
  state.found = [];
  state.executed = 0;
});

describe("uniqueViolation", () => {
  const refused = (detail: string) => ({ code: "23505", constraint_name: "unique_value_key_idx", detail });

  it("reads the property and value the triggers name", () => {
    expect(uniqueViolation(refused("Key (property_id, key)=(p-1, ada, lovelace) already exists."))).toEqual({
      propertyId: "p-1",
      key: "ada, lovelace",
    });
  });

  it("marks a value the index names by its hash", () => {
    expect(uniqueViolation({ cause: refused("Key (property_id, md5(key))=(p-1, 0cc175b9c0f1b6a831c399e269772661) already exists.") })).toEqual({
      propertyId: "p-1",
      key: "0cc175b9c0f1b6a831c399e269772661",
      hashed: true,
    });
  });

  it("leaves other errors alone", () => {
    expect(uniqueViolation({ code: "23505", constraint_name: "page_pkey", detail: "Key (id)=(x) already exists." })).toBeNull();
    expect(uniqueViolation(new Error("boom"))).toBeNull();
  });
});

describe("dropRepeatedValues", () => {
  it("leaves out and counts the values another row holds or an earlier row takes", async () => {
    state.props = [{ id: "email", type: "email" }];
    // Keys as Postgres folds them, in the batch's order, with the row holding each one.
    state.found = [
      [
        { ord: "1", key: "a@x.test", held_by: "r1" },
        { ord: "2", key: "a@x.test", held_by: "r1" },
        { ord: "3", key: "b@x.test", held_by: null },
        { ord: "4", key: "b@x.test", held_by: null },
      ],
    ];
    const rows = [
      { rowId: "r1", properties: { email: "A@x.test" } },
      { properties: { email: "a@x.test", note: "kept" } },
      { rowId: "r2", properties: { email: "b@x.test" } },
      { properties: { email: "B@x.test " } },
    ];
    const invalid = new Map<string, number>([["email", 1]]);
    await dropRepeatedValues("db-1", rows, invalid);
    expect(rows.map((r) => r.properties)).toEqual([{ email: "A@x.test" }, { note: "kept" }, { email: "b@x.test" }, {}]);
    expect(invalid.get("email")).toBe(3);
  });

  it("asks nothing when no value goes to a unique property", async () => {
    state.props = [{ id: "email", type: "email" }];
    const rows = [{ properties: { note: "x" } }];
    await dropRepeatedValues("db-1", rows, new Map());
    expect(state.executed).toBe(0);
    expect(rows[0].properties).toEqual({ note: "x" });
  });
});

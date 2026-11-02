import { describe, expect, it } from "vitest";
import { rowStatusOf } from "./row-status";

describe("rowStatusOf", () => {
  it("reads an option's name, color and whether it is done", () => {
    expect(rowStatusOf({ id: "a", name: "In progress", color: "blue", group: "in_progress" })).toEqual({ name: "In progress", color: "blue", done: false });
    expect(rowStatusOf({ id: "b", name: "Done", color: "green", group: "done" })).toEqual({ name: "Done", color: "green", done: true });
  });

  it("counts an option without a known group as to do, as status properties do", () => {
    expect(rowStatusOf({ id: "c", name: "Later", color: "gray" })?.done).toBe(false);
    expect(rowStatusOf({ id: "c", name: "Later", color: "gray", group: "finished" })?.done).toBe(false);
  });

  it("paints an unknown color gray", () => {
    expect(rowStatusOf({ id: "d", name: "Odd", color: "#ff0000", group: "todo" })?.color).toBe("gray");
    expect(rowStatusOf({ id: "d", name: "Odd", group: "todo" })?.color).toBe("gray");
  });

  it("gives nothing for no option or a broken one", () => {
    expect(rowStatusOf(null)).toBeNull();
    expect(rowStatusOf("done")).toBeNull();
    expect(rowStatusOf([])).toBeNull();
    expect(rowStatusOf({ id: "e", name: "  ", color: "red" })).toBeNull();
    expect(rowStatusOf({ id: "e", color: "red" })).toBeNull();
  });
});

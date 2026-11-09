import { describe, expect, it } from "vitest";
import { mergeListEdit } from "./list-merge";

describe("mergeListEdit", () => {
  it("keeps the edit as written when nobody else changed the list", () => {
    expect(mergeListEdit(["a", "b"], ["a", "b"], ["b", "a", "c"])).toEqual(["b", "a", "c"]);
  });

  it("keeps what someone else added meanwhile", () => {
    // Read [a]; meanwhile someone made it [a, b]; this edit adds c.
    expect(mergeListEdit(["a", "b"], ["a"], ["a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("takes away only what this edit took away", () => {
    expect(mergeListEdit(["a", "b", "c"], ["a", "b"], ["b"])).toEqual(["b", "c"]);
  });

  it("keeps someone else's removal", () => {
    // Read [a, b]; meanwhile b was removed; this edit adds c.
    expect(mergeListEdit(["a"], ["a", "b"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("clears only this edit's items", () => {
    expect(mergeListEdit(["a", "b"], ["a"], null)).toEqual(["b"]);
  });

  it("adds nothing twice", () => {
    expect(mergeListEdit(["a", "c"], ["a"], ["a", "c"])).toEqual(["a", "c"]);
  });

  it("tells objects apart by their content", () => {
    const one = { url: "/f/1", name: "one.pdf" };
    const two = { url: "/f/2", name: "two.pdf" };
    const three = { url: "/f/3", name: "three.pdf" };
    expect(mergeListEdit([one, two], [one], [one, three])).toEqual([one, two, three]);
  });

  it("reads a single value as a list of one", () => {
    expect(mergeListEdit("a", null, ["b"])).toEqual(["a", "b"]);
  });
});

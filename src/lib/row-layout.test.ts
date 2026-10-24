import { describe, expect, it } from "vitest";
import { canPin, MAX_PINNED, pinnedSplit } from "./row-layout";

const prop = (id: string, pinned = false) => ({ id, options: pinned ? { pinned: true as const } : {} });

describe("pinnedSplit", () => {
  it("takes the pinned properties out of the list, both in their order", () => {
    const props = [prop("a"), prop("b", true), prop("c"), prop("d", true)];
    expect(pinnedSplit(props)).toEqual({ pinned: [props[1], props[3]], rest: [props[0], props[2]] });
    expect(pinnedSplit([])).toEqual({ pinned: [], rest: [] });
  });

  it("pins no more than the strip holds: the others stay in the list", () => {
    const props = Array.from({ length: MAX_PINNED + 2 }, (_, i) => prop(`p${i}`, true));
    const { pinned, rest } = pinnedSplit(props);
    expect(pinned.map((p) => p.id)).toEqual(props.slice(0, MAX_PINNED).map((p) => p.id));
    expect(rest.map((p) => p.id)).toEqual(props.slice(MAX_PINNED).map((p) => p.id));
  });
});

describe("canPin", () => {
  it("pins while there is room, and a pinned property stays pinnable", () => {
    const full = Array.from({ length: MAX_PINNED }, (_, i) => prop(`p${i}`, true));
    expect(canPin([...full.slice(1), prop("x")], "x")).toBe(true);
    expect(canPin([...full, prop("x")], "x")).toBe(false);
    expect(canPin(full, "p0")).toBe(true);
  });
});

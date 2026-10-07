import { describe, expect, it } from "vitest";
import { isForeignBuild } from "./build-id";

describe("isForeignBuild", () => {
  it("is foreign when both builds are known and differ, either way round", () => {
    expect(isForeignBuild("a", "b")).toBe(true);
    expect(isForeignBuild("b", "a")).toBe(true);
  });

  it("is not foreign for the same build, ignoring surrounding whitespace", () => {
    expect(isForeignBuild("a", "a")).toBe(false);
    expect(isForeignBuild("a", "a\n")).toBe(false);
  });

  it("never locks anyone out on a build it doesn't know", () => {
    expect(isForeignBuild("", "b")).toBe(false);
    expect(isForeignBuild("a", null)).toBe(false);
    expect(isForeignBuild(undefined, "b")).toBe(false);
    expect(isForeignBuild("a", "  ")).toBe(false);
  });
});

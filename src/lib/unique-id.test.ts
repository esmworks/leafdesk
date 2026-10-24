import { describe, expect, it } from "vitest";
import { cleanUniqueIdPrefix, formatUniqueId, parseUniqueId, uniqueIdNumber, uniqueIdPrefix, uniqueIdQuery } from "./unique-id";

describe("cleanUniqueIdPrefix", () => {
  it("stores letters and digits in upper case, without a trailing dash", () => {
    expect(cleanUniqueIdPrefix(" task ")).toBe("TASK");
    expect(cleanUniqueIdPrefix("Bug-")).toBe("BUG");
    expect(cleanUniqueIdPrefix("q4")).toBe("Q4");
    expect(cleanUniqueIdPrefix("ABCDEFGHIJ")).toBe("ABCDEFGHIJ");
  });

  it("reads empty as none", () => {
    expect(cleanUniqueIdPrefix("")).toBeNull();
    expect(cleanUniqueIdPrefix("  ")).toBeNull();
    expect(cleanUniqueIdPrefix(null)).toBeNull();
    expect(cleanUniqueIdPrefix(undefined)).toBeNull();
  });

  it("refuses other characters and long prefixes", () => {
    expect(cleanUniqueIdPrefix("ABCDEFGHIJK")).toBeUndefined();
    expect(cleanUniqueIdPrefix("A B")).toBeUndefined();
    expect(cleanUniqueIdPrefix("A-B")).toBeUndefined();
    expect(cleanUniqueIdPrefix("GÖREV")).toBeUndefined();
    expect(cleanUniqueIdPrefix(12)).toBeUndefined();
  });
});

describe("formatUniqueId", () => {
  it("shows the prefix and the number", () => {
    expect(formatUniqueId(12, "TASK")).toBe("TASK-12");
    expect(formatUniqueId(12, null)).toBe("12");
    expect(formatUniqueId(12)).toBe("12");
  });

  it("shows nothing for a row without a number", () => {
    expect(formatUniqueId(null, "TASK")).toBe("");
    expect(formatUniqueId("12", "TASK")).toBe("");
    expect(formatUniqueId(0, "TASK")).toBe("");
    expect(formatUniqueId(1.5, "TASK")).toBe("");
    expect(uniqueIdNumber(-3)).toBeNull();
  });

  it("reads a property's prefix", () => {
    expect(uniqueIdPrefix({ options: { uniqueId: { prefix: "BUG" } } })).toBe("BUG");
    expect(uniqueIdPrefix({ options: {} })).toBeNull();
  });
});

describe("parseUniqueId", () => {
  it("reads IDs with the property's prefix, in any case, and bare numbers", () => {
    expect(parseUniqueId("TASK-12", "TASK")).toBe(12);
    expect(parseUniqueId("task-12", "TASK")).toBe(12);
    expect(parseUniqueId(" TASK 12 ", "TASK")).toBe(12);
    expect(parseUniqueId("12", "TASK")).toBe(12);
    expect(parseUniqueId(12, "TASK")).toBe(12);
    expect(parseUniqueId("7", null)).toBe(7);
  });

  it("refuses another prefix and text that isn't an ID", () => {
    expect(parseUniqueId("BUG-12", "TASK")).toBeNull();
    expect(parseUniqueId("TASK-12", null)).toBeNull();
    expect(parseUniqueId("TASK-", "TASK")).toBeNull();
    expect(parseUniqueId("twelve", "TASK")).toBeNull();
    expect(parseUniqueId("12.5", "TASK")).toBeNull();
    expect(parseUniqueId(true, "TASK")).toBeNull();
  });
});

describe("uniqueIdQuery", () => {
  it("finds a whole ID with its prefix", () => {
    expect(uniqueIdQuery("TASK-12")).toEqual({ prefix: "TASK", number: 12 });
    expect(uniqueIdQuery(" task-12 ")).toEqual({ prefix: "TASK", number: 12 });
    expect(uniqueIdQuery("Q4-3")).toEqual({ prefix: "Q4", number: 3 });
  });

  it("leaves bare numbers, dates and other text to the full-text search", () => {
    expect(uniqueIdQuery("12")).toBeNull();
    expect(uniqueIdQuery("2026-10")).toBeNull();
    expect(uniqueIdQuery("TASK 12")).toBeNull();
    expect(uniqueIdQuery("plan TASK-12")).toBeNull();
    expect(uniqueIdQuery("TASK-0")).toBeNull();
  });
});

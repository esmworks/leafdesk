import { describe, expect, it } from "vitest";
import { parseMessageSearch, searchAsks } from "./message-search-query";

const resolve = {
  person: (name: string) => ({ me: "u-me", ann: "u-ann", "ann lee": "u-ann" })[name.toLowerCase()] ?? null,
  channel: (name: string) => ({ design: "c-design" })[name.toLowerCase()] ?? null,
};

describe("parseMessageSearch", () => {
  it("reads filters and keeps the words", () => {
    const s = parseMessageSearch('launch from:@ann in:#design has:file "next week"', resolve);
    expect(s).toMatchObject({ query: 'launch "next week"', from: ["u-ann"], in: ["c-design"], has: ["file"] });
  });

  it("reads quoted names", () => {
    expect(parseMessageSearch('from:"Ann Lee" hello', resolve).from).toEqual(["u-ann"]);
  });

  it("keeps filters it can't resolve as words", () => {
    const s = parseMessageSearch("from:@zed in:#nowhere has:cats before:tomorrow", resolve);
    expect(s.from).toEqual([]);
    expect(s.query).toBe("from:@zed in:#nowhere has:cats before:tomorrow");
  });

  it("reads days, on: as one whole day", () => {
    const s = parseMessageSearch("on:2026-03-05", resolve);
    expect(new Date(s.after!).getDate()).toBe(5);
    expect(new Date(s.before!).getDate()).toBe(6);
    expect(parseMessageSearch("after:2026-02-30", resolve).after).toBeNull();
  });

  it("knows an empty search", () => {
    expect(searchAsks(parseMessageSearch("  ", resolve))).toBe(false);
    expect(searchAsks(parseMessageSearch("has:pin", resolve))).toBe(true);
  });
});

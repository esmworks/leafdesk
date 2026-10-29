import { describe, expect, it } from "vitest";
import { decodeRead, encodeRead } from "./read-wire";

describe("read-wire", () => {
  it("keeps dates, nested and in arrays", () => {
    const at = new Date("2026-10-29T08:00:00Z");
    const back = decodeRead(encodeRead({ at, list: [{ at }], n: 1, s: "x", nothing: null })) as { at: Date; list: { at: Date }[] };
    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.getTime()).toBe(at.getTime());
    expect(back.list[0].at.getTime()).toBe(at.getTime());
    expect(back).toMatchObject({ n: 1, s: "x", nothing: null });
  });

  it("keeps undefined arguments undefined, so defaults apply", () => {
    const args = decodeRead(encodeRead(["ws", undefined, false, undefined])) as unknown[];
    expect(args).toHaveLength(4);
    expect(args[1]).toBeUndefined();
    expect(args[3]).toBeUndefined();
    const read = (a: string, b = "default", c?: boolean, d: object = {}) => [a, b, c, d];
    expect(read(...(args as [string, undefined, boolean, undefined]))).toEqual(["ws", "default", false, {}]);
  });

  it("drops undefined properties and reads nothing as undefined", () => {
    expect(decodeRead(encodeRead({ a: undefined, b: 1 }))).toEqual({ b: 1 });
    expect(encodeRead(undefined)).toBe("");
    expect(decodeRead("")).toBeUndefined();
  });

  it("leaves objects that only look tagged alone", () => {
    expect(decodeRead(JSON.stringify({ __leafdeskDate: "soon" }))).toEqual({ __leafdeskDate: "soon" });
    expect(decodeRead(JSON.stringify({ __leafdeskDate: 1, other: 2 }))).toEqual({ __leafdeskDate: 1, other: 2 });
  });

  it("refuses what JSON can't carry", () => {
    expect(() => encodeRead({ m: new Map() })).toThrow(TypeError);
    expect(() => encodeRead([new Set()])).toThrow(TypeError);
    expect(() => encodeRead({ big: BigInt(1) })).toThrow(TypeError);
  });
});

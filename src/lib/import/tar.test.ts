import { describe, expect, it } from "vitest";
import { tar } from "./tar-fixtures";
import { looksLikeTar, readTar, TarError } from "./tar";

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("readTar", () => {
  it("reads the plain files with their names and bytes", () => {
    const data = tar({ "a.md": "hello", "resources/b.png": new Uint8Array([1, 2, 3]), "empty.md": "" });
    expect(looksLikeTar(data)).toBe(true);
    const entries = readTar(data, () => true);
    expect(entries.map((e) => e.name)).toEqual(["a.md", "resources/b.png", "empty.md"]);
    expect(text(entries[0].data)).toBe("hello");
    expect([...entries[1].data]).toEqual([1, 2, 3]);
    expect(entries[2].data.length).toBe(0);
  });

  it("asks before taking each file, and takes only what it's told", () => {
    const seen: [string, number][] = [];
    const entries = readTar(tar({ "a.md": "12345", "b.md": "x" }), (name, size) => {
      seen.push([name, size]);
      return name === "b.md";
    });
    expect(seen).toEqual([
      ["a.md", 5],
      ["b.md", 1],
    ]);
    expect(entries.map((e) => e.name)).toEqual(["b.md"]);
  });

  it("reads GNU long names", () => {
    const long = `${"folder/".repeat(20)}note.md`;
    expect(readTar(tar({ [long]: "x" }), () => true).map((e) => e.name)).toEqual([long]);
  });

  it("refuses what isn't a tar archive or is cut short", () => {
    expect(looksLikeTar(new TextEncoder().encode("not a tar".repeat(100)))).toBe(false);
    expect(() => readTar(new Uint8Array(512).fill(65), () => true)).toThrow(TarError);
    const data = tar({ "a.md": "x".repeat(2000) });
    expect(() => readTar(data.subarray(0, 1024), () => true)).toThrow(TarError);
  });

  it("stops at the end blocks and reads an empty archive as nothing", () => {
    expect(readTar(new Uint8Array(1024), () => true)).toEqual([]);
  });
});

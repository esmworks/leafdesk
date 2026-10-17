import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEntry, zipEntries, ZipFormatError } from "./zip-reader";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zip-reader-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = (s: string) => new TextEncoder().encode(s);

describe("zip reader", () => {
  it("reads stored and deflated entries, a ZIP inside the ZIP included", async () => {
    const inner = zipSync({ "a.txt": text("inner") }, { level: 0 });
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const path = join(dir, "ok.zip");
    await writeFile(path, zipSync({ "manifest.json": text("{}"), "files/inner": [inner, { level: 0 }], "files/big": big, empty: new Uint8Array() }));
    const entries = await zipEntries(path);
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", "files/inner", "files/big", "empty"]);
    expect(Buffer.from(await readEntry(path, entries[1], 1e9)).equals(Buffer.from(inner))).toBe(true);
    expect(Buffer.from(await readEntry(path, entries[2], 1e9)).equals(Buffer.from(big))).toBe(true);
    expect((await readEntry(path, entries[3], 1e9)).length).toBe(0);
    await expect(readEntry(path, entries[2], 10)).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("notices damage and what isn't a ZIP", async () => {
    const path = join(dir, "damaged.zip");
    await writeFile(path, zipSync({ "a.txt": [text("hello hello hello"), { level: 0 }] }));
    const bytes = await readFile(path);
    bytes[bytes.indexOf("hello") + 1] = "X".charCodeAt(0);
    await writeFile(path, bytes);
    const [entry] = await zipEntries(path);
    await expect(readEntry(path, entry, 1e9)).rejects.toBeInstanceOf(ZipFormatError);

    const junk = join(dir, "junk.zip");
    await writeFile(junk, "not a zip at all");
    await expect(zipEntries(junk)).rejects.toBeInstanceOf(ZipFormatError);
  });
});

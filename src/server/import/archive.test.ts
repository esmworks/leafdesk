import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { collectFiles } from "./archive";

const ID = "0123456789abcdef0123456789abcdef";
const UUID = "4f2e8c1a-1b2c-4d3e-8f90-123456789abc";
const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));

describe("collectFiles", () => {
  it("unpacks Notion's split export: an Export ZIP holding its parts", () => {
    const outer = zip({
      [`Export-${UUID}-Part-1.zip`]: zip({ [`Home ${ID}.md`]: "# Home", [`Home ${ID}/Child.md`]: "# Child" }),
      [`Export-${UUID}-Part-2.zip`]: zip({ [`Export-${UUID}-Part-2/Tasks ${ID}.csv`]: "Name\nA\n" }),
    });
    const { files, skipped } = collectFiles([{ path: `Export-${UUID}.zip`, data: outer }]);
    expect([...files.keys()].sort()).toEqual([`Home ${ID}.md`, `Home ${ID}/Child.md`, `Tasks ${ID}.csv`]);
    expect(skipped).toEqual([]);
  });

  it("leaves out ZIPs nested deeper and entries climbing out of the archive, and says so", () => {
    const data = zip({
      "ok.md": "fine",
      "../evil.md": "outside",
      "a/../../evil2.md": "outside too",
      "one.zip": zip({ "two.zip": zip({ "deep.md": "x" }), "inner.md": "y" }),
    });
    const { files, skipped } = collectFiles([{ path: "upload.zip", data }]);
    expect([...files.keys()].sort()).toEqual(["inner.md", "ok.md"]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: "../evil.md", reason: "unsafePath" },
        { path: "a/../../evil2.md", reason: "unsafePath" },
        { path: "two.zip", reason: "nestedZip" },
      ]),
    );
  });

  it("refuses more unpacked bytes than the limit before unpacking them", () => {
    // 301 MB of zeros packs into a few hundred KB; the directory's sizes give it away.
    const big = new Uint8Array(301 * 1024 * 1024);
    const data = zipSync({ "big.md": big }, { level: 1 });
    expect(() => collectFiles([{ path: "bomb.zip", data }])).toThrow(/too large/);
    // Packing 301 MB takes a few seconds, more while the other test files run alongside.
  }, 60_000);

  it("counts a stored entry by the bytes it copies, even when its directory says it unpacks to nothing", () => {
    // One stored 1 MB entry, and 301 directory records pointing at it, each saying it unpacks to
    // 0 bytes: unpacking copies 1 MB per record all the same.
    const payload = new Uint8Array(1024 * 1024);
    const data = storedZipSharingOneEntry(payload, 301);
    expect(() => collectFiles([{ path: "shared.zip", data }])).toThrow(expect.objectContaining({ code: "tooLarge" }));
  }, 60_000);
});

/**
 * A ZIP written by hand: a single stored (uncompressed) entry, and `records` central directory
 * records with names of their own that all point at it, with the real packed size and an unpacked
 * size of 0.
 */
function storedZipSharingOneEntry(payload: Uint8Array, records: number): Uint8Array {
  const localName = strToU8("a.md");
  const names = Array.from({ length: records }, (_, i) => strToU8(`f${i}.md`));
  const localSize = 30 + localName.length + payload.length;
  const directorySize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const out = new Uint8Array(localSize + directorySize + 22);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint32(18, payload.length, true);
  view.setUint32(22, payload.length, true);
  view.setUint16(26, localName.length, true);
  out.set(localName, 30);
  out.set(payload, 30 + localName.length);
  let at = localSize;
  for (const name of names) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 10, 0, true); // stored
    view.setUint32(at + 20, payload.length, true); // packed size
    view.setUint32(at + 24, 0, true); // unpacked size
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, 0, true); // the one local entry
    out.set(name, at + 46);
    at += 46 + name.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, records, true);
  view.setUint16(at + 10, records, true);
  view.setUint32(at + 12, directorySize, true);
  view.setUint32(at + 16, localSize, true);
  return out;
}

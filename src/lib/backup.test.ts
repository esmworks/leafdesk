import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, decodeValue, encodeValue, entryKind, fileEntryPath, idRewriter, parseManifest, rewriteDeep, tableEntryPath } from "./backup";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const manifest = {
  format: BACKUP_FORMAT,
  version: 1,
  schema: "0099_example",
  app: "1.0.0",
  createdAt: "2026-10-17T00:00:00.000Z",
  workspace: { id: "ws", name: "Team" },
  people: [{ id: A, email: "a@example.com", name: "A", emailVerified: true, agent: false }],
  tables: [{ name: "page", rows: 3 }],
  files: { count: 0, bytes: 0 },
  embeddings: null,
};

describe("entries", () => {
  it("names table parts and files, and knows nothing else", () => {
    expect(tableEntryPath("page", 2)).toBe("tables/page/0002.jsonl");
    expect(entryKind(tableEntryPath("page_link", 12))).toEqual({ kind: "table", table: "page_link" });
    const id = "x".repeat(24);
    expect(entryKind(fileEntryPath(id))).toEqual({ kind: "file", id });
    expect(entryKind("manifest.json")).toEqual({ kind: "manifest" });
    for (const path of ["../manifest.json", "tables/page/1.jsonl", "tables/Page/0001.jsonl", "files/short", `files/${id}/x`, "/manifest.json"]) {
      expect(entryKind(path)).toBeNull();
    }
  });
});

describe("parseManifest", () => {
  it("reads a manifest", () => {
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("refuses what isn't one", () => {
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, format: "other" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, files: { count: -1, bytes: 0 } }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, people: [{ id: A }] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...manifest, embeddings: { model: 1 } }))).toBeNull();
  });
});

describe("values", () => {
  it("round-trip dates and bytes through JSON", () => {
    const date = new Date("2026-01-02T03:04:05.678Z");
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const json = JSON.parse(JSON.stringify({ d: encodeValue("timestamp", date), b: encodeValue("bytes", bytes), o: encodeValue("other", { x: [1] }) }));
    expect(decodeValue("timestamp", json.d)).toEqual(date);
    expect(decodeValue("bytes", json.b)).toEqual(bytes);
    expect(decodeValue("other", json.o)).toEqual({ x: [1] });
    expect(decodeValue("timestamp", null)).toBeNull();
  });

  it("refuses values of the wrong kind", () => {
    expect(() => decodeValue("timestamp", "yesterday")).toThrow();
    expect(() => decodeValue("bytes", 12)).toThrow();
  });
});

describe("idRewriter", () => {
  it("rewrites people's ids wherever they appear", () => {
    const rewrite = idRewriter(new Map([[A, B], [C, C]]))!;
    expect(rewrite(A)).toBe(B);
    expect(rewrite(`mention:${A} and ${C}`)).toBe(`mention:${B} and ${C}`);
    expect(rewrite("me")).toBe("me");
  });

  it("is null when nothing changes", () => {
    expect(idRewriter(new Map([[A, A]]))).toBeNull();
    expect(idRewriter(new Map([["short", "other"]]))).toBeNull();
  });

  it("rewrites strings and keys inside JSON, leaving bytes and dates alone", () => {
    const rewrite = idRewriter(new Map([[A, B]]))!;
    const date = new Date();
    const bytes = new Uint8Array([1]);
    expect(rewriteDeep({ [A]: [A, 1, null, { who: A }], date, bytes }, rewrite)).toEqual({ [B]: [B, 1, null, { who: B }], date, bytes });
    const out = rewriteDeep({ bytes }, rewrite) as { bytes: unknown };
    expect(out.bytes).toBeInstanceOf(Uint8Array);
  });
});

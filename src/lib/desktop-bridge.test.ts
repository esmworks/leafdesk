import { describe, expect, it } from "vitest";
import { isFolderLabel, localPlace, MAX_LOCAL_FILE_BYTES, readDesktopMessage } from "./desktop-bridge";

const folders = ["Documents", "Notes (2)"];

describe("localPlace", () => {
  it("takes a folder and a path inside it, dropping empty and . parts", () => {
    expect(localPlace("Documents/a/b.md", folders)).toEqual({ folder: "Documents", parts: ["a", "b.md"], path: "Documents/a/b.md" });
    expect(localPlace(" Documents//./a/ ", folders)).toEqual({ folder: "Documents", parts: ["a"], path: "Documents/a" });
    expect(localPlace("Notes (2)", folders)).toEqual({ folder: "Notes (2)", parts: [], path: "Notes (2)" });
  });

  it("refuses going up, backslashes, control characters and unknown folders", () => {
    for (const raw of ["Documents/../x", "../Documents", "Documents/a/../../etc", "Documents\\..\\x", "Documents/a\u0000b", "Desktop/a", "/Documents/a", "", 42]) {
      const out = localPlace(raw, folders);
      if (raw === "/Documents/a") expect(out).toEqual({ folder: "Documents", parts: ["a"], path: "Documents/a" });
      else expect(out, String(raw)).toHaveProperty("error");
    }
    expect(localPlace("documents/a", folders)).toHaveProperty("error");
  });
});

describe("isFolderLabel", () => {
  it("is a name, never a path", () => {
    expect(isFolderLabel("Documents")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", " pad", "x".repeat(101), 3]) expect(isFolderLabel(bad)).toBe(false);
  });
});

describe("readDesktopMessage", () => {
  it("reads hello, pong and results", () => {
    expect(readDesktopMessage(JSON.stringify({ type: "hello", version: "1.2.3", folders }))).toEqual({ type: "hello", version: "1.2.3", folders });
    expect(readDesktopMessage('{"type":"pong"}')).toEqual({ type: "pong" });
    expect(readDesktopMessage(JSON.stringify({ type: "result", id: "a", ok: false, error: "denied" }))).toEqual({ type: "result", id: "a", ok: false, error: "denied" });
    expect(readDesktopMessage(JSON.stringify({ type: "result", id: "a", ok: false, error: "whatever" }))).toEqual({ type: "result", id: "a", ok: false, error: "failed" });
    expect(readDesktopMessage(JSON.stringify({ type: "result", id: "a", ok: true, result: { op: "read", text: "hi", bytes: 2 } }))).toEqual({
      type: "result",
      id: "a",
      ok: true,
      result: { op: "read", text: "hi", bytes: 2 },
    });
  });

  it("refuses folders that are paths or repeat, and answers too large", () => {
    expect(readDesktopMessage(JSON.stringify({ type: "hello", version: "1", folders: ["a/b"] }))).toBeNull();
    expect(readDesktopMessage(JSON.stringify({ type: "hello", version: "1", folders: ["a", "a"] }))).toBeNull();
    expect(readDesktopMessage("not json")).toBeNull();
    const big = readDesktopMessage(JSON.stringify({ type: "result", id: "a", ok: true, result: { op: "read", text: "x".repeat(MAX_LOCAL_FILE_BYTES + 1) } }));
    expect(big).toEqual({ type: "result", id: "a", ok: false, error: "failed" });
  });

  it("keeps a listing's entries to their fields", () => {
    const out = readDesktopMessage(
      JSON.stringify({ type: "result", id: "a", ok: true, result: { op: "list", entries: [{ name: "a.md", kind: "file", size: 3, modified: "2026-01-01", extra: 1 }, { kind: "file" }], truncated: false } }),
    );
    expect(out).toEqual({ type: "result", id: "a", ok: true, result: { op: "list", entries: [{ name: "a.md", kind: "file", size: 3, modified: "2026-01-01" }], truncated: false } });
  });
});

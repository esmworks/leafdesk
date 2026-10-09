import { describe, expect, it } from "vitest";
import { decodeSharedNote, encodeSharedNote } from "./shared-note";

describe("shared notes", () => {
  it("carries what was shared through the cookie", () => {
    const note = { title: "Çay saati", text: "Bugün 17:00 — mutfakta", url: "https://example.com/a?b=1" };
    expect(decodeSharedNote(encodeSharedNote(note))).toEqual(note);
  });

  it("cuts a text too long for a cookie, and keeps the rest", () => {
    const value = encodeSharedNote({ title: "Long", text: "ğ".repeat(10_000), url: "https://example.com" });
    expect(value.length).toBeLessThanOrEqual(3_600);
    const note = decodeSharedNote(value)!;
    expect(note.title).toBe("Long");
    expect(note.url).toBe("https://example.com");
    expect(note.text.endsWith("…")).toBe(true);
    expect(note.text.length).toBeGreaterThan(500);
  });

  it("reads nothing from a value it didn't write", () => {
    expect(decodeSharedNote(undefined)).toBeNull();
    expect(decodeSharedNote("not base64 json")).toBeNull();
  });
});

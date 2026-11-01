import { describe, expect, it } from "vitest";
import { livePreview } from "./agent-chat-preview";

describe("live preview of an agent's answer", () => {
  it("shows nothing before there is text", () => {
    expect(livePreview("  \n", 50)).toBe("");
  });

  it("shows a short text whole, escaped and marked", () => {
    expect(livePreview("a < b & c", 50)).toBe("a &lt; b &amp; c ✍️");
  });

  it("cuts a long text so that its escaped form stays within the limit", () => {
    const text = "&".repeat(40);
    const preview = livePreview(text, 50);
    expect(preview.length).toBeLessThanOrEqual(50);
    expect(preview).toBe(`${"&amp;".repeat(9)}… ✍️`);
  });

  it("never cuts inside an escaped character", () => {
    const preview = livePreview(`${"x".repeat(44)}<<<<`, 50);
    expect(preview.length).toBeLessThanOrEqual(50);
    expect(preview).toBe(`${"x".repeat(44)}… ✍️`);
  });

  it("never cuts between the halves of a surrogate pair", () => {
    const preview = livePreview(`${"x".repeat(45)}😀😀😀`, 50);
    expect(preview.length).toBeLessThanOrEqual(50);
    expect(preview).toBe(`${"x".repeat(45)}… ✍️`);
    expect(livePreview(`${"x".repeat(44)}😀😀😀`, 50)).toBe(`${"x".repeat(44)}😀… ✍️`);
  });
});

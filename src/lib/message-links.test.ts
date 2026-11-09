import { describe, expect, it } from "vitest";
import { messageLinks } from "./message-links";

describe("messageLinks", () => {
  it("finds bare and Markdown links in order, once each", () => {
    expect(messageLinks("See https://example.com/a and [docs](https://docs.example.org/x?y=1). Again https://example.com/a")).toEqual([
      "https://example.com/a",
      "https://docs.example.org/x?y=1",
    ]);
  });

  it("drops a sentence's punctuation after an address", () => {
    expect(messageLinks("Read https://example.com/page, then https://example.com/next.")).toEqual(["https://example.com/page", "https://example.com/next"]);
  });

  it("leaves out code, angle brackets and what skip refuses", () => {
    const body = "`https://code.example.com` ```\nhttps://block.example.com\n``` <https://quiet.example.com> https://app.leafdesk.test/w/1 https://kept.example.com";
    expect(messageLinks(body, (u) => u.hostname === "app.leafdesk.test")).toEqual(["https://kept.example.com/"]);
  });

  it("takes at most three, and no hosts without a dot or with credentials", () => {
    expect(messageLinks("http://localhost:3000 https://u:p@x.example.com https://a.io https://b.io https://c.io https://d.io")).toEqual([
      "https://a.io/",
      "https://b.io/",
      "https://c.io/",
    ]);
  });

  it("ignores http inside a word", () => {
    expect(messageLinks("xhttps://example.com")).toEqual([]);
  });

  it("stays fast on long words without addresses", () => {
    const body = "http".repeat(10_000) + "`".repeat(10_000);
    const started = performance.now();
    messageLinks(body);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

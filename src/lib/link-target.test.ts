import { describe, expect, it } from "vitest";
import { linkTarget } from "./link-target";

describe("linkTarget", () => {
  it("keeps addresses with a scheme and paths in the app", () => {
    expect(linkTarget("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(linkTarget(" mailto:ada@example.com ")).toBe("mailto:ada@example.com");
    expect(linkTarget("tel:+905551112233")).toBe("tel:+905551112233");
    expect(linkTarget("/w/ws-1/p/page-1")).toBe("/w/ws-1/p/page-1");
  });

  it("gives a bare host https", () => {
    expect(linkTarget("example.com")).toBe("https://example.com");
    expect(linkTarget("docs.example.co.uk/guide#start")).toBe("https://docs.example.co.uk/guide#start");
    expect(linkTarget("localhost.dev:3000/x")).toBe("https://localhost.dev:3000/x");
  });

  it("reads words as a search", () => {
    for (const text of ["", "Roadmap", "Q3 plan", "v1.2", "notes.", "//evil.example", "javascript:alert(1)"]) {
      expect(linkTarget(text), text).toBeNull();
    }
  });
});

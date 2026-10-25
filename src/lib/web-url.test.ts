import { describe, expect, it } from "vitest";
import { shownAddress } from "./web-url";

describe("shownAddress", () => {
  it("drops the scheme, a leading www. and a trailing slash", () => {
    expect(shownAddress("https://www.example.com/")).toBe("example.com");
    expect(shownAddress("https://docs.example.com/guide/start?x=1#top")).toBe("docs.example.com/guide/start?x=1#top");
    expect(shownAddress("http://localhost:3000/a/")).toBe("localhost:3000/a");
  });

  it("reads escaped paths and email addresses", () => {
    expect(shownAddress("https://tr.wikipedia.org/wiki/%C4%B0stanbul")).toBe("tr.wikipedia.org/wiki/İstanbul");
    expect(shownAddress("mailto:ada@example.com")).toBe("ada@example.com");
  });

  it("gives back what it can't read as it is", () => {
    expect(shownAddress("not a url")).toBe("not a url");
    expect(shownAddress("https://example.com/%E0%A4%A")).toBe("https://example.com/%E0%A4%A");
  });
});

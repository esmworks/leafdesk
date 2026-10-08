import { describe, expect, it } from "vitest";
import { sameOriginPath } from "./same-origin";

const APP = "https://notes.example.com";

describe("sameOriginPath", () => {
  it("keeps paths and addresses on this site", () => {
    expect(sameOriginPath("/w/abc?x=1", APP)).toBe("/w/abc?x=1");
    expect(sameOriginPath(`${APP}/w/abc`, APP)).toBe("/w/abc");
    expect(sameOriginPath("w/abc", APP)).toBe("/w/abc");
    // Same scheme, no slashes: a path on this site to browsers too.
    expect(sameOriginPath("https:evil.example", APP)).toBe("/evil.example");
  });

  it("turns away other sites, however they are written", () => {
    for (const target of [
      "https://evil.example/w",
      "//evil.example/w",
      "/\\evil.example",
      "\\\\evil.example",
      "/\\/evil.example",
      "\\/evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "http://notes.example.com/w",
    ]) {
      expect(sameOriginPath(target, APP), target).toBeNull();
    }
  });

  it("has nothing for no target", () => {
    expect(sameOriginPath(null, APP)).toBeNull();
    expect(sameOriginPath("", APP)).toBeNull();
  });
});

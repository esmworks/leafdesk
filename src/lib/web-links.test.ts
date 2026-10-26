import { describe, expect, it } from "vitest";
import { classifyAnswer, classifyFailure, isReported, markdownWebLinks, normalizeWebLink, recheckAfterMs, UNREACHABLE_FAILURES } from "./web-links";

describe("markdownWebLinks", () => {
  it("finds links, autolinks and bare addresses once each", () => {
    const md = [
      "See [the docs](https://example.com/docs) and <https://example.org/a>.",
      "Also https://example.net/page, and again [here](https://example.com/docs#part).",
      '[titled](https://example.com/t "A title")',
    ].join("\n");
    expect(markdownWebLinks(md).sort()).toEqual(["https://example.com/docs", "https://example.com/t", "https://example.net/page", "https://example.org/a"]);
  });

  it("leaves out images, code and pages of the app", () => {
    const md = [
      "![a picture](https://example.com/p.png)",
      "`https://example.com/inline`",
      "```",
      "curl https://example.com/in-code",
      "```",
      "[a page](/w/abc/p/def) and [a file](/api/files/x)",
      "[mail](mailto:someone@example.com)",
      "~~~~ts",
      "const u = 'https://example.com/tilde';",
      "~~~~",
    ].join("\n");
    expect(markdownWebLinks(md)).toEqual([]);
    expect(markdownWebLinks("```\nhttps://example.com/a\n```\n\nAfter https://example.com/b\n\n```js\nhttps://example.com/c")).toEqual([
      "https://example.com/b",
    ]);
  });

  it("keeps parentheses that belong to the address, drops the sentence's", () => {
    expect(markdownWebLinks("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(markdownWebLinks("[x](https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(markdownWebLinks("Go to https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(markdownWebLinks('"https://example.com/q?x=1"')).toEqual(["https://example.com/q?x=1"]);
  });
});

describe("normalizeWebLink", () => {
  it("keeps http(s) addresses without the fragment", () => {
    expect(normalizeWebLink("https://Example.com/a#b")).toBe("https://example.com/a");
    expect(normalizeWebLink("ftp://example.com")).toBeNull();
    expect(normalizeWebLink("https://user:pw@example.com")).toBeNull();
    expect(normalizeWebLink("not a url")).toBeNull();
    expect(normalizeWebLink(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("reading answers", () => {
  it("counts only 404 and 410 as broken at once", () => {
    expect(classifyAnswer(404)).toEqual({ status: "broken", httpStatus: 404, reason: "notFound" });
    expect(classifyAnswer(410).reason).toBe("gone");
    expect(classifyAnswer(503)).toEqual({ status: "unreachable", httpStatus: 503, reason: "serverError" });
    for (const code of [200, 301, 401, 403, 405, 429]) expect(classifyAnswer(code).status).toBe("ok");
  });

  it("reads failures without an answer", () => {
    expect(classifyFailure("ENOTFOUND").reason).toBe("noHost");
    expect(classifyFailure("ECONNREFUSED").reason).toBe("unreachable");
    expect(classifyFailure(undefined).status).toBe("unreachable");
  });

  it("lists unreachable sites only after several failures", () => {
    expect(isReported({ status: "broken", failures: 1 })).toBe(true);
    expect(isReported({ status: "unreachable", failures: UNREACHABLE_FAILURES - 1 })).toBe(false);
    expect(isReported({ status: "unreachable", failures: UNREACHABLE_FAILURES })).toBe(true);
    expect(isReported({ status: "ok", failures: 0 })).toBe(false);
  });

  it("checks failing addresses again sooner than working ones", () => {
    expect(recheckAfterMs("unreachable")).toBeLessThan(recheckAfterMs("broken"));
    expect(recheckAfterMs("broken")).toBeLessThan(recheckAfterMs("ok"));
  });
});

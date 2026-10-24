import { describe, expect, it } from "vitest";
import { linkedImageMarkdown, parseImageLink, parseLinkedImageLine } from "./image-links";

describe("parseImageLink", () => {
  it("keeps web addresses and the app's page links", () => {
    expect(parseImageLink(" https://example.com/a?b=1 ")).toEqual({ kind: "url", href: "https://example.com/a?b=1" });
    expect(parseImageLink("/w/ws1/p/page-1")).toEqual({ kind: "page", href: "/w/ws1/p/page-1", pageId: "page-1" });
    expect(parseImageLink("https://app.test/w/ws1/p/page-1", "https://app.test")).toEqual({ kind: "page", href: "/w/ws1/p/page-1", pageId: "page-1" });
  });

  it("refuses anything else", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "mailto:a@b.c", "//evil.test/x", "/settings", "https://user:pw@example.com", "", 42, null]) {
      expect(parseImageLink(bad)).toBeNull();
    }
    expect(parseImageLink(`https://example.com/${"a".repeat(2000)}`)).toBeNull();
  });
});

describe("linked image Markdown", () => {
  it("writes an image in a link, and reads it back", () => {
    const props = { url: "https://x.test/a b.png", name: "A [chart]", caption: "", link: "https://example.com/x", showPreview: true };
    const line = linkedImageMarkdown(props)!;
    expect(line).toBe("[![A \\[chart\\]](<https://x.test/a%20b.png>)](https://example.com/x)");
    expect(parseLinkedImageLine(line)).toEqual({ url: "https://x.test/a%20b.png", name: "A [chart]", caption: "", link: "https://example.com/x" });
  });

  it("writes a captioned one as a figure, and reads it back", () => {
    const line = linkedImageMarkdown({ url: "/api/files/f1", name: 'Say "hi"', caption: "Q3 <draft> & more", link: "/w/ws1/p/page-1" })!;
    expect(line).toBe('<figure><a href="/w/ws1/p/page-1"><img alt="Say &quot;hi&quot;" src="/api/files/f1"></a><figcaption>Q3 &lt;draft&gt; &amp; more</figcaption></figure>');
    expect(parseLinkedImageLine(line)).toEqual({ url: "/api/files/f1", name: 'Say "hi"', caption: "Q3 <draft> & more", link: "/w/ws1/p/page-1" });
  });

  it("writes nothing special for an image without a (valid) link", () => {
    expect(linkedImageMarkdown({ url: "https://x.test/a.png", link: "" })).toBeNull();
    expect(linkedImageMarkdown({ url: "https://x.test/a.png", link: "javascript:alert(1)" })).toBeNull();
    expect(linkedImageMarkdown({ url: "", link: "https://example.com" })).toBeNull();
  });

  it("reads only links an image may hold", () => {
    expect(parseLinkedImageLine("[![a](https://x.test/a.png)](javascript:alert(1))")).toBeNull();
    expect(parseLinkedImageLine("[![a](https://x.test/a.png)](https://app.test/w/w/p/p1)", "https://app.test")?.link).toBe("/w/w/p/p1");
    expect(parseLinkedImageLine("Text [![a](https://x.test/a.png)](https://example.com)")).toBeNull();
    expect(parseLinkedImageLine("![a](https://x.test/a.png)")).toBeNull();
  });
});

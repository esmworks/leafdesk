import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/html-block/frame/route";
import { cleanHtmlHeight, clampReportedHeight, htmlBlockMarkdown, htmlBlockMarker, parseHtmlBlockMarker } from "./html-block";
import { HTML_FRAME_CSP, HTML_FRAME_DOCUMENT, HTML_FRAME_PATH, HTML_FRAME_SANDBOX } from "./html-frame";

const directives = (policy: string) => new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));

describe("the HTML block's frame", () => {
  it("is sandboxed by its own policy, with no origin of the app's and no network", () => {
    const csp = directives(HTML_FRAME_CSP);
    expect(csp.get("sandbox")).toBe("allow-scripts");
    expect(HTML_FRAME_CSP).not.toContain("allow-same-origin");
    expect(csp.get("default-src")).toBe("'none'");
    expect(csp.get("connect-src")).toBe("'none'");
    expect(csp.get("script-src")).toBe("'unsafe-inline'");
    expect(csp.get("form-action")).toBe("'none'");
    expect(csp.get("frame-src")).toBe("'none'");
    expect(csp.get("frame-ancestors")).toBe("'self'");
    // Nothing loads from anywhere but the frame's own text: no site, no origin, no wildcard.
    expect(HTML_FRAME_CSP.replace("frame-ancestors 'self'", "")).not.toMatch(/https?:|\*|'self'/);
    expect(csp.get("img-src")).toBe("data: blob:");
    expect(HTML_FRAME_SANDBOX).toBe("allow-scripts");
  });

  it("is served with that policy and no nonce policy beside it", async () => {
    const res = GET();
    expect(res.headers.get("content-security-policy")).toBe(HTML_FRAME_CSP);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe(HTML_FRAME_DOCUMENT);
    expect(HTML_FRAME_PATH).toBe("/api/html-block/frame");
  });

  it("holds only the shell: it loads nothing and takes its source from the embedding page alone", () => {
    expect(HTML_FRAME_DOCUMENT).not.toMatch(/src=|href=|https?:\/\//);
    expect(HTML_FRAME_DOCUMENT).toContain("event.source !== host");
    // The block runs in a sandboxed frame inside the shell, whose frame-src 'none' holds its navigations.
    expect(HTML_FRAME_DOCUMENT).toContain('inner.setAttribute("sandbox", "allow-scripts")');
    expect(HTML_FRAME_DOCUMENT).toContain("inner.srcdoc");
    expect(HTML_FRAME_DOCUMENT).not.toContain("document.write");
    expect(HTML_FRAME_CSP).toContain("frame-src 'none'");
    // The inner frame's script sits in a string inside the shell's own script: it must not end it.
    const shellScript = HTML_FRAME_DOCUMENT.slice(HTML_FRAME_DOCUMENT.indexOf("<script>") + 8, HTML_FRAME_DOCUMENT.lastIndexOf("</script>"));
    expect(shellScript).not.toContain("</script>");
  });

  it("keeps heights within the limits", () => {
    expect(clampReportedHeight(1e9)).toBe(2000);
    expect(clampReportedHeight(3)).toBe(40);
    expect(clampReportedHeight(120.2)).toBe(121);
    expect(clampReportedHeight("100")).toBeNull();
    expect(clampReportedHeight(Number.NaN)).toBeNull();
    expect(cleanHtmlHeight(0)).toBe(0);
    expect(cleanHtmlHeight("250")).toBe(250);
    expect(cleanHtmlHeight(-5)).toBe(0);
  });
});

describe("the HTML block's Markdown marker", () => {
  it("round-trips a title and height, however odd the title", () => {
    const line = htmlBlockMarker({ title: 'A "quoted" --> title', height: 300 });
    expect(line).not.toMatch(/-->.*-->/);
    expect(parseHtmlBlockMarker(line)).toEqual({ title: 'A "quoted" --> title', height: 300 });
  });
  it("reads a bare marker and refuses other lines", () => {
    expect(parseHtmlBlockMarker("<!-- leafdesk:html -->")).toEqual({ title: "", height: 0 });
    expect(parseHtmlBlockMarker("<!-- leafdesk:html {oops} -->")).toEqual({ title: "", height: 0 });
    expect(parseHtmlBlockMarker("<!-- leafdesk:toc -->")).toBeNull();
    expect(parseHtmlBlockMarker("text <!-- leafdesk:html -->")).toBeNull();
  });
  it("picks a fence longer than any run of backticks", () => {
    expect(htmlBlockMarkdown({ source: "a ``` b" }).split("\n")[1]).toBe("````html");
    expect(htmlBlockMarkdown({ source: "plain" }).split("\n")[1]).toBe("```html");
  });
});

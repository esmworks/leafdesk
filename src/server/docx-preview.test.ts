import { describe, expect, it } from "vitest";
import { DocxPreviewFailure, docxPreviewHtml, pictureSources } from "./docx-preview";
import { docx, hyperlink, image, paragraph, PNG, run, table } from "./import/docx-fixtures";

describe("DOCX preview", () => {
  it("writes the document as clean HTML: safe links only, its own pictures inline, nothing from outside", async () => {
    const { html, picturesLeftOut } = await docxPreviewHtml(
      "Report.docx",
      docx({
        body: [
          paragraph("Quarterly <report>", { style: "Heading1" }),
          paragraph([run("Bold", { bold: true }), run(" "), hyperlink("rIdWeb", "web"), run(" "), hyperlink("rIdScript", "script")]),
          paragraph([image({ embed: "rIdPicture" }, "A dot")]),
          paragraph([image({ link: "rIdOutside" })]),
          table([["Plant", "Water"], ["Fern", "Daily"]], { header: true }),
        ].join(""),
        relationships: [
          { id: "rIdWeb", type: "hyperlink", target: "https://example.com/page", external: true },
          { id: "rIdScript", type: "hyperlink", target: "javascript:alert(1)", external: true },
          { id: "rIdPicture", type: "image", target: "media/image1.png" },
          { id: "rIdOutside", type: "image", target: "https://example.com/tracker.png", external: true },
        ],
        media: { "image1.png": PNG },
      }),
    );
    expect(html.startsWith("<h1>Quarterly &#60;report&#62;</h1>")).toBe(true);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('href="https://example.com/page"');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("script");
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}"`);
    expect(html).not.toContain("tracker.png");
    expect(html).not.toContain("leafdesk-docx-image");
    expect(html).toContain("<table");
    expect(html).toContain("Fern");
    expect(html).not.toMatch(/<script|<iframe|<style|\son\w+=/i);
    expect(picturesLeftOut).toBe(false);
  });

  it("leaves out pictures pages don't show and those past the limits", () => {
    const picture = (token: string, contentType: string, size: number) => ({ token, contentType, data: new Uint8Array(size) });
    const { urls, leftOut } = pictureSources(
      [picture("a", "image/png", 10), picture("b", "image/svg+xml", 10), picture("c", "image/x-emf", 10), picture("d", "image/jpeg", 50), picture("e", "image/gif", 30)],
      { pictureBytes: 40, picturesBytes: 45, concurrent: 1, queue: 1, cached: 1, bytes: 1 },
    );
    expect([...urls.keys()]).toEqual(["a", "e"]);
    expect(urls.get("a")).toBe(`data:image/png;base64,${Buffer.alloc(10).toString("base64")}`);
    expect(leftOut).toBe(true);
  });

  it("says a file that isn't a Word document can't be read", async () => {
    const failure = await docxPreviewHtml("x.docx", new TextEncoder().encode("not a zip")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DocxPreviewFailure);
    expect((failure as DocxPreviewFailure).code).toBe("unreadable");
  });
});

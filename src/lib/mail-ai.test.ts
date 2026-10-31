import { describe, expect, it } from "vitest";
import { draftHtml } from "./mail-ai";

describe("draftHtml", () => {
  it("writes a paragraph per line and an empty one per blank line, as typing does", () => {
    expect(draftHtml("Merhaba Ayşe,\n\nTeklif ekte.\nCuma uygun.\n\n\nSaygılarımla,")).toBe("<p>Merhaba Ayşe,</p><p></p><p>Teklif ekte.</p><p>Cuma uygun.</p><p></p><p>Saygılarımla,</p>");
  });

  it("writes list lines as lists and keeps bold", () => {
    expect(draftHtml("Gerekenler:\n- **fatura**\n- irsaliye\n\n1. ilk\n2) ikinci")).toBe(
      "<p>Gerekenler:</p><ul><li><p><strong>fatura</strong></p></li><li><p>irsaliye</p></li></ul><p></p><ol><li><p>ilk</p></li><li><p>ikinci</p></li></ol>",
    );
  });

  it("never lets the model's text become markup", () => {
    const html = draftHtml('<img src=x onerror="alert(1)"> & <a href="javascript:x">link</a>\n\n[site](https://example.test)');
    expect(html).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;a href=&quot;javascript:x&quot;&gt;link&lt;/a&gt;</p><p></p><p>[site](https://example.test)</p>");
  });

  it("drops a code fence the model wrapped its answer in, and empty answers give nothing", () => {
    expect(draftHtml("```\nMerhaba\n```")).toBe("<p>Merhaba</p>");
    expect(draftHtml("  \n\n ")).toBe("");
  });
});

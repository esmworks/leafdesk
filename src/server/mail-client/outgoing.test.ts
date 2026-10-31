import { describe, expect, it } from "vitest";
import { cleanSignature, outgoingBody } from "./outgoing";

describe("outgoingBody", () => {
  it("keeps the editor's formatting and drops everything else", async () => {
    const { html } = await outgoingBody(
      `<p>Merhaba <strong>Ayşe</strong>, <em>teklif</em> <u>ekte</u> <s>yok</s>.</p><h1 onclick="x()">Başlık</h1><script>alert(1)</script><p><img src="https://track.example/p.gif"><span style="color:red">kırmızı</span></p>`,
    );
    expect(html).toContain("<strong>Ayşe</strong>");
    expect(html).toContain("<em>teklif</em> <u>ekte</u> <s>yok</s>");
    expect(html).not.toMatch(/<h1|onclick|<script|alert|<img|track\.example|color:red|<span/);
    expect(html).toContain("Başlık");
    expect(html).toContain("kırmızı");
  });

  it("keeps links to the web and addresses only", async () => {
    const { html } = await outgoingBody(`<p><a href="https://leafdesk.app" target="_blank">site</a> <a href="javascript:alert(1)">kötü</a> <a href="mailto:ada@example.test">yaz</a></p>`);
    expect(html).toContain(`<a href="https://leafdesk.app">site</a>`);
    expect(html).toContain(`<a href="mailto:ada@example.test">yaz</a>`);
    expect(html).not.toContain("javascript");
    expect(html).toContain("kötü");
  });

  it("keeps pictures only from the message's own parts", async () => {
    const { html, text } = await outgoingBody(
      `<p>Logo:</p><img src="cid:a1b2.c3@leafdesk" alt="logo"><img src="https://track.example/p.gif"><img src="data:image/png;base64,AAAA"><img src="cid:bad id"><p><a href="cid:a1b2.c3@leafdesk">bağ</a></p>`,
    );
    expect(html).toContain(`<img src="cid:a1b2.c3@leafdesk" alt="logo" style="max-width:100%;height:auto">`);
    expect(html).not.toMatch(/track\.example|data:image|bad id|href="cid/);
    expect(html).toContain("bağ");
    expect(text).toBe("Logo:\nbağ");
  });

  it("writes lines, lists and quotes as plain text", async () => {
    const { text, html } = await outgoingBody(
      `<p>Merhaba,</p><p></p><ul><li><p>bir</p></li><li><p>iki<br>devam</p></li></ul><ol><li><p>ilk</p></li><li><p>son</p></li></ol><p><a href="https://leafdesk.app">site</a></p><blockquote><p>Önceki</p><p></p><p>ileti</p></blockquote>`,
    );
    expect(text).toBe("Merhaba,\n\n- bir\n- iki\n  devam\n1. ilk\n2. son\nsite <https://leafdesk.app>\n> Önceki\n>\n> ileti");
    expect(html).toContain(`<p style="margin:0"><br></p>`);
    expect(html).toContain("<blockquote style=");
  });

  it("writes a signature under a separator line and sends it as plain paragraphs", async () => {
    const { text, html } = await outgoingBody(`<p>Merhaba,</p><p></p><div data-signature=""><p><strong>Ayşe Yılmaz</strong></p><p><a href="https://leafdesk.app">leafdesk.app</a></p></div>`);
    expect(text).toBe("Merhaba,\n\n-- \nAyşe Yılmaz\nleafdesk.app <https://leafdesk.app>");
    expect(html).toContain(`<div style="margin:0"><p style="margin:0"><strong>Ayşe Yılmaz</strong></p>`);
    expect(html).not.toContain("data-signature");
  });

  it("drops a signature whose words were taken out", async () => {
    const { text, html } = await outgoingBody(`<p>Merhaba</p><div data-signature=""><p></p></div>`);
    expect(text).toBe("Merhaba");
    expect(html).not.toContain("<div style=\"margin:0\">");
  });
});

describe("cleanSignature", () => {
  it("takes no pictures", async () => {
    expect((await cleanSignature(`<p>Ada</p><img src="cid:a@leafdesk">`))?.html).toBe("<p>Ada</p>");
  });

  it("keeps the formatting a message may have and no signature inside it", async () => {
    const signed = await cleanSignature(`<p><em>Ayşe</em> <img src="https://x.example/logo.png"></p><div data-signature=""><p>iç</p></div><p></p><p></p>`);
    expect(signed).toEqual({ html: "<p><em>Ayşe</em> </p><p>iç</p>", text: "Ayşe\niç" });
  });

  it("is nothing when nothing is written", async () => {
    expect(await cleanSignature("<p></p><p> </p>")).toBeNull();
  });
});

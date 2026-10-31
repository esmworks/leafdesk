import { describe, expect, it } from "vitest";
import { cleanSignature, editableBody, outgoingBody } from "./outgoing";

/** A signature as another mail program copies it: a table of a logo and lines, icons in links, styles inline. */
const PASTED = `<meta charset="utf-8"><style>td{color:red}</style><p>-- </p><table style="font-family:Arial" id="sig" class="x"><tbody><tr><td><img src="https://cdn.example/logo.png" width="180" alt="Günay"></td><td style="border-left:1px solid #1a4d8f"><p style="color:#1a4d8f"><b>Erhan ERBAŞ</b><br>Satış Müdürü</p><a href="tel:+902127711771">+90 (212) 771 1 771</a><br><a href="https://www.gunaysogutma.com.tr">www.gunaysogutma.com.tr</a></td></tr></tbody></table><p><a href="https://instagram.com/gunay"><img src="https://cdn.example/ig.png"></a> <img src="file:///C:/sig/x.png" onerror="alert(1)"><script>alert(2)</script></p>`;

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

  it("sends a pasted signature as it came, under a separator line", async () => {
    const signature = (await cleanSignature(`<div data-pasted="">${PASTED}</div>`))!.html;
    const { text, html } = await outgoingBody(`<p>Merhaba,</p><p></p><div data-signature="">${signature}</div><div data-pasted=""><img src="https://x.example/a.png"></div>`);
    expect(html).toContain(`<table style="font-family:Arial"><tbody><tr><td><img src="https://cdn.example/logo.png" width="180" alt="Günay"></td><td style="border-left:1px solid #1a4d8f"><p style="color:#1a4d8f">`);
    expect(html).toContain(`<a href="https://instagram.com/gunay"><img src="https://cdn.example/ig.png"></a>`);
    expect(html).not.toMatch(/data-pasted|data-signature|x\.example/);
    expect(text).toBe("Merhaba,\n\n-- \nErhan ERBAŞ\nSatış Müdürü\n+90 (212) 771 1 771\nwww.gunaysogutma.com.tr");
  });

  it("keeps a pasted signature in a draft, to open again with its pictures beside the message's own", async () => {
    const signature = (await cleanSignature(`<div data-pasted="">${PASTED}</div>`))!.html;
    const { html } = await outgoingBody(`<p>Merhaba</p><img src="cid:a1@leafdesk"><div data-signature="">${signature}</div>`, { keepSignature: true });
    const opened = await editableBody(html, "");
    expect(opened).toContain(`<img src="cid:a1@leafdesk">`);
    expect(opened).toMatch(/<div data-signature=""><div data-pasted="">[\s\S]*<img [^>]*src="https:/);
    expect(opened).not.toContain("-apple-system");
  });

  it("cleans a pasted signature again as it goes, wherever it came from", async () => {
    const { html } = await outgoingBody(`<p>Merhaba</p><div data-signature=""><div data-pasted=""><img src="https://cdn.example/logo.png" onerror="alert(1)"><iframe src="https://x.example"></iframe></div></div>`);
    expect(html).toContain(`<img src="https://cdn.example/logo.png">`);
    expect(html).not.toMatch(/onerror|iframe/);
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

  it("keeps a pasted signature's images, layout and styles, but nothing that runs or reaches the message", async () => {
    const signed = await cleanSignature(`<div data-pasted="">${PASTED}</div>`);
    expect(signed!.html).toMatch(/^<div data-pasted=""><p>-- <\/p><table style="font-family:Arial"><tbody>/);
    expect(signed!.html).toContain(`<a href="tel:+902127711771">`);
    expect(signed!.html).not.toMatch(/<style|<meta|<script|onerror|alert|file:|id="sig"|class=/);
    expect(signed!.text).toBe("Erhan ERBAŞ\nSatış Müdürü\n+90 (212) 771 1 771\nwww.gunaysogutma.com.tr");
  });

  it("keeps a pasted signature of images alone, and nothing of an empty one", async () => {
    expect(await cleanSignature(`<div data-pasted=""><img src="https://cdn.example/banner.png"></div>`)).toEqual({ html: `<div data-pasted=""><img src="https://cdn.example/banner.png"></div>`, text: "" });
    expect(await cleanSignature(`<div data-pasted=""><p> </p><img src="file:///x.png"></div>`)).toBeNull();
  });

  it("is nothing when nothing is written", async () => {
    expect(await cleanSignature("<p></p><p> </p>")).toBeNull();
  });
});

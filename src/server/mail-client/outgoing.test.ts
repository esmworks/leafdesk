import { describe, expect, it } from "vitest";
import { outgoingBody } from "./outgoing";

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

  it("writes lines, lists and quotes as plain text", async () => {
    const { text, html } = await outgoingBody(
      `<p>Merhaba,</p><p></p><ul><li><p>bir</p></li><li><p>iki<br>devam</p></li></ul><ol><li><p>ilk</p></li><li><p>son</p></li></ol><p><a href="https://leafdesk.app">site</a></p><blockquote><p>Önceki</p><p></p><p>ileti</p></blockquote>`,
    );
    expect(text).toBe("Merhaba,\n\n- bir\n- iki\n  devam\n1. ilk\n2. son\nsite <https://leafdesk.app>\n> Önceki\n>\n> ileti");
    expect(html).toContain(`<p style="margin:0"><br></p>`);
    expect(html).toContain("<blockquote style=");
  });
});

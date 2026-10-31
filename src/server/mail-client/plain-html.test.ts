import { describe, expect, it } from "vitest";
import { cleanMailHtml } from "./html";

const plain = async (raw: string) => (await cleanMailHtml(raw, { images: false, inline: new Map() })).plain;

describe("isPlainHtml", () => {
  it("takes mail in default colors as plain", async () => {
    expect(await plain('<div dir="ltr">Bu bir denemedir</div>')).toBe(true);
    // Sent from here (outgoing.ts), Gmail's signature grey, Apple Mail's body.
    expect(await plain(`<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#1f2328"><p>Merhaba</p></div>`)).toBe(true);
    expect(await plain('<div>Ada</div><div class="gmail_signature"><span style="color:rgb(136,136,136)">--<br>Ada Kaya</span></div>')).toBe(true);
    expect(await plain('<body style="overflow-wrap: break-word; -webkit-nbsp-mode: space;"><div>Tamam</div></body>')).toBe(true);
    expect(await plain('<table border="1" bgcolor="#ffffff"><tr><td style="background-color:white">1</td></tr></table>')).toBe(true);
    expect(await plain('<blockquote style="margin:0 0 0 .8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">Gelir misiniz?</blockquote>')).toBe(true);
  });

  it("doesn't count link colors, in styles or rules", async () => {
    expect(await plain('<a href="https://example.com" style="color:rgb(17,85,204)"><span style="color:#0563c1">bağlantı</span></a>')).toBe(true);
    const outlook = '<html><head><style>a:link, span.MsoHyperlink {color:#0563C1; text-decoration:underline} span.EmailStyle17 {font-family:"Calibri"; color:windowtext} @media screen { p.MsoNormal {margin:0} }</style></head><body lang="TR" link="#0563C1" vlink="#954F72"><p class="MsoNormal">Selamlar</p></body></html>';
    expect(await plain(outlook)).toBe(true);
  });

  it("takes colors, backgrounds and pictures as designed for a white page", async () => {
    expect(await plain('<p style="color:#1F497D">Lacivert</p>')).toBe(false);
    expect(await plain('<font color="red">kırmızı</font>')).toBe(false);
    expect(await plain('<body bgcolor="#003366"><p>x</p></body>')).toBe(false);
    expect(await plain('<table bgcolor="#f4f4f4"><tr><td style="background:#2f7d4f">x</td></tr></table>')).toBe(false);
    expect(await plain('<div style="background-color:#eaeaea">gri kutu</div>')).toBe(false);
    expect(await plain('<p style="color:#000 !important">x</p>')).toBe(false);
    expect(await plain('<p style="color:var(--x)">x</p>')).toBe(false);
    expect(await plain("<html><head><style>.box{background:#123456}</style></head><body><div class=box>x</div></body></html>")).toBe(false);
    expect(await plain('<p>Logo</p><img src="https://example.com/logo.png">')).toBe(false);
    expect(await plain('<img src="data:image/png;base64,AAAA">')).toBe(false);
  });

  it("judges an answer's quote apart from what is written above it", async () => {
    const out = await cleanMailHtml('<div>Tamam.</div><div class="gmail_quote"><table bgcolor="#003366"><tr><td><font color="#ffffff">Bülten</font></td></tr></table></div>', { images: false, inline: new Map() });
    expect(out.plain).toBe(true);
    expect(out.quotedPlain).toBe(false);
  });
});

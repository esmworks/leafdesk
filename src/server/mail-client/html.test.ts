import { describe, expect, it } from "vitest";
import { cleanMailHtml } from "./html";

const clean = async (raw: string, images = true) => (await cleanMailHtml(raw, { images, inline: new Map() })).html.replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");

describe("cleanMailHtml", () => {
  it("keeps a message's sizes, alignment, colors and table spans", async () => {
    expect(await clean('<img width="38" height="38" src="https://example.com/a.png">')).toBe('<img width="38" height="38" src="https://example.com/a.png">');
    const table = await clean('<div dir="ltr"><table width="600" border="0" cellpadding="4" bgcolor="#ffffff"><tr><td colspan="2" align="center" valign="top">x</td></tr></table><font size="2" face="Arial" color="red">f</font></div>');
    for (const kept of ['dir="ltr"', 'width="600"', 'border="0"', 'cellpadding="4"', 'bgcolor="#ffffff"', 'colspan="2"', 'align="center"', 'valign="top"', 'size="2"', 'face="Arial"', 'color="red"']) expect(table).toContain(kept);
  });

  it("keeps web, mail and relative links and drops scripts in them", async () => {
    expect(await clean('<a href="https://example.com/x?a=1">a</a>')).toContain('href="https://example.com/x?a=1"');
    expect(await clean('<a href="mailto:a@example.com">a</a>')).toContain('href="mailto:a@example.com"');
    expect(await clean('<a href="#top">a</a>')).toContain('href="#top"');
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:x", "data:text/html,<b>x</b>"]) {
      expect(await clean(`<a href="${bad}">a</a>`)).not.toContain("href=");
    }
  });

  it("keeps images carried as data and takes out images from other sites until asked", async () => {
    expect(await clean('<img src="data:image/png;base64,AAAA">', false)).toContain('src="data:image/png;base64,AAAA"');
    const blocked = await cleanMailHtml('<img width="420" src="https://example.com/sig.png">', { images: false, inline: new Map() });
    expect(blocked.html).toContain('width="420"');
    expect(blocked.html).not.toContain("example.com");
    expect(blocked.blockedImages).toBe(1);
  });

  it("hides the boxes, links and paragraphs a left-out image leaves empty, but not text or table cells", async () => {
    const box = '<span style="display:inline-block;overflow:hidden;width:38px;height:38px"><img src="https://example.com/i.png" width="38" height="38"></span>';
    const html = await clean(`<p>İyi çalışmalar,</p><p id="icons"><a href="https://example.com/a">${box}</a><a href="https://example.com/b">${box}</a></p><p id="mixed">Ara ${box}</p><table><tr><td id="cell">${box}</td><td>x</td></tr></table>`, false);
    const document = new (await import("jsdom")).JSDOM(html).window.document;
    expect(document.querySelector("#icons")?.hasAttribute("data-blocked")).toBe(true);
    expect(document.querySelector("#mixed")?.hasAttribute("data-blocked")).toBe(false);
    expect(document.querySelector("#mixed span")?.hasAttribute("data-blocked")).toBe(true);
    expect(document.querySelector("#cell")?.hasAttribute("data-blocked")).toBe(false);
    expect(document.querySelector("#cell span")?.hasAttribute("data-blocked")).toBe(true);
    expect(document.body.textContent).toContain("İyi çalışmalar,");
  });

  it("leaves images and their boxes alone once images are asked for, and hides parts the message doesn't carry", async () => {
    expect(await clean('<span style="width:38px"><img src="https://example.com/i.png"></span>', true)).not.toContain("data-blocked");
    expect(await clean('<img src="cid:missing@x" width="420" height="111">', true)).toContain("data-blocked");
  });
});

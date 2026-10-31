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
});

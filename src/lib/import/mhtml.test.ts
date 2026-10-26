import { describe, expect, it } from "vitest";
import { decodeBase64, decodeQuotedPrintable, findPart, headerParams, partText, readMhtml, MHTML_LIMITS } from "./mhtml";
import { fast, randomTexts } from "./linear-fixtures";
import { mhtml, oneNoteFile, oneNoteHtml, oneNotePage, PNG_BASE64, quotedPrintable } from "./mhtml-fixtures";

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const utf8 = new TextDecoder();

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

describe("decoding parts", () => {
  it("reads quoted-printable: escaped bytes, soft line breaks, trailing spaces", () => {
    expect(utf8.decode(decodeQuotedPrintable("<p class=3D\"a\">Caf=C3=A9 =\r\nau lait</p>  \r\nnext"))).toBe('<p class="a">Café au lait</p>\r\nnext');
    expect(utf8.decode(decodeQuotedPrintable("soft=\nbreak =3d =3D"))).toBe("softbreak = =");
    // A stray "=" that escapes nothing stays.
    expect(utf8.decode(decodeQuotedPrintable("a = b =ZZ"))).toBe("a = b =ZZ");
    const round = new TextEncoder().encode(`${"x".repeat(100)} = ü\r\nline`);
    expect(decodeQuotedPrintable(quotedPrintable(round))).toEqual(round);
  });

  it("reads base64 across lines, with missing padding", () => {
    expect(utf8.decode(decodeBase64("SGVs\r\nbG8g\nd29y bGQ="))).toBe("Hello world");
    expect(utf8.decode(decodeBase64("SGVsbG8"))).toBe("Hello");
  });

  it("reads header parameters, quoted or not", () => {
    const { value, params } = headerParams('multipart/related; boundary="----=_Next;Part"; type=text/html; START="<root@x>"');
    expect(value).toBe("multipart/related");
    expect(params.get("boundary")).toBe("----=_Next;Part");
    expect(params.get("type")).toBe("text/html");
    expect(params.get("start")).toBe("<root@x>");
  });
});

describe("readMhtml", () => {
  it("splits a OneNote export into its HTML and files, decoded", () => {
    const html = oneNoteHtml([oneNotePage({ title: "Plan", outlines: ["<p>Hello wörld</p><img src=\"Notes_files/image001.png\">"] })]);
    const archive = readMhtml("Plan.mht", oneNoteFile(html, { "image001.png": PNG_BASE64 }));
    expect(archive.parts.map((p) => p.type)).toEqual(["text/html", "image/png", "text/xml"]);
    expect(archive.root).toBe(archive.parts[0]);
    expect(archive.root.charset).toBe("utf-8");
    expect(partText(archive.root)).toBe(html.replace(/\n/g, "\r\n"));
    expect(archive.parts[1].data).toEqual(decodeBase64(PNG_BASE64));
    expect(archive.parts[1].location).toBe("file:///C:/Users/Ana/AppData/Local/Temp/0D1E1F8B/Notes_files/image001.png");
  });

  it("finds parts by Content-Location, absolute, relative to the page, or by name alone, and by cid", () => {
    const archive = readMhtml(
      "a.mht",
      mhtml(
        [
          { type: "text/css", location: "https://example.com/style.css", body: "p {}" },
          { type: "text/html", id: "page@mhtml.blink", location: "https://example.com/blog/post.html", body: "<p>x</p>" },
          { type: "image/png", location: "https://example.com/blog/img/a%20b.png", encoding: "base64", body: PNG_BASE64 },
          { type: "image/gif", id: "Logo@Mail", encoding: "base64", body: PNG_BASE64 },
          { type: "image/png", location: "file:///C:/Docs/Report_files/image001.png", encoding: "base64", body: PNG_BASE64 },
        ],
        { start: "page@mhtml.blink" },
      ),
    );
    expect(archive.root.location).toBe("https://example.com/blog/post.html");
    const base = archive.root.location;
    const find = (ref: string, from: string | null = base) => findPart(archive, ref, from)?.type ?? null;
    expect(find("img/a b.png")).toBe("image/png");
    expect(find("https://example.com/blog/img/a%20b.png")).toBe("image/png");
    expect(find("../style.css")).toBe("text/css");
    expect(find("cid:logo@mail")).toBe("image/gif");
    expect(find("cid:%3CLogo@Mail%3E")).toBe("image/gif");
    expect(find("Report_files/image001.png", null)).toBe("image/png");
    expect(find("file:///c:/docs/report_files/IMAGE001.png")).toBe("image/png");
    expect(find("https://example.com/elsewhere.png")).toBeNull();
    expect(find("cid:missing")).toBeNull();
  });

  it("reads each text part in its character set: declared, in a <meta>, a byte order mark, else UTF-8 or Windows-1252", () => {
    const latin = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    const archive = readMhtml(
      "c.mht",
      mhtml([
        { type: "text/html", charset: "iso-8859-1", encoding: "8bit", body: "", bytes: latin("<p>caf\u00e9</p>") },
        { type: "text/html", encoding: "quoted-printable", body: "", bytes: latin('<meta charset="windows-1254"><p>\u00fd</p>') },
        { type: "text/html", encoding: "base64", body: btoa("\u00ff\u00fe<\u0000p\u0000>\u0000") },
        { type: "text/html", encoding: "8bit", body: "<p>ışık</p>" },
        { type: "text/html", encoding: "8bit", body: "", bytes: latin("<p>\u0093quoted\u0094</p>") },
        { type: "text/html", charset: "x-unknown-charset", encoding: "8bit", body: "<p>ok</p>" },
      ]),
    );
    expect(archive.parts.map(partText)).toEqual(["<p>café</p>", '<meta charset="windows-1254"><p>ı</p>', "<p>", "<p>ışık</p>", "<p>\u201cquoted\u201d</p>", "<p>ok</p>"]);
  });

  it("takes a file without a closing boundary, nested multiparts, and LF line ends", () => {
    const text = [
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain",
      "",
      "plain",
      "--inner",
      "Content-Type: text/html",
      "",
      "<p>rich</p>",
      "--inner--",
      "--outer",
      "Content-Type: image/png",
      "Content-Location: a.png",
      "Content-Transfer-Encoding: base64",
      "",
      PNG_BASE64,
    ].join("\n");
    const archive = readMhtml("n.mht", bytes(text));
    expect(archive.parts.map((p) => p.type)).toEqual(["text/plain", "text/html", "image/png"]);
    expect(partText(archive.root)).toBe("<p>rich</p>");
    expect(archive.parts[2].data).toEqual(decodeBase64(PNG_BASE64));
  });

  it("takes a lone HTML message, and refuses files that aren't web archives", () => {
    expect(partText(readMhtml("s.mht", bytes("Content-Type: text/html\r\n\r\n<p>one</p>")).root)).toBe("<p>one</p>");
    expect(code(() => readMhtml("x.mht", bytes("<html><p>not MIME</p></html>")))).toBe("badMhtml");
    expect(code(() => readMhtml("x.mht", mhtml([{ type: "image/png", encoding: "base64", body: PNG_BASE64 }])))).toBe("badMhtml");
    expect(code(() => readMhtml("x.mht", bytes("MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n")))).toBe("badMhtml");
  });

  it("refuses more parts than the limit", () => {
    const parts = Array.from({ length: MHTML_LIMITS.parts + 1 }, (_, i) => ({ type: "text/html", body: `<p>${i}</p>` }));
    expect(code(() => readMhtml("many.mht", mhtml(parts)))).toBe("tooManyFiles");
  });
});

describe("crafted files are read in time growing with their length", () => {
  it("quoted-printable: long runs of spaces, as the regex it replaces read them", () => {
    expect(fast(() => decodeQuotedPrintable(`${" ".repeat(1_000_000)}x`)).length).toBe(1_000_001);
    expect(fast(() => decodeQuotedPrintable(`a${" \t".repeat(500_000)}\r\nb`))).toEqual(bytes("a\r\nb"));
    const before = (text: string) =>
      bytes(
        text
          .replace(/[ \t]+(?=\r?\n)/g, "")
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      );
    for (const text of randomTexts([" ", "\t", "\r", "\n", "\r\n", "a", "="])) expect(decodeQuotedPrintable(text)).toEqual(before(text));
  });

  it("header parameters: a long value without `=`, and the same parameters as before", () => {
    expect(fast(() => headerParams(`text/html; ${"a".repeat(1_000_000)}`)).params.size).toBe(0);
    expect(fast(() => headerParams(`text/html; ${" ".repeat(500_000)}x=1`)).params.get("x")).toBe("1");
    const before = (value: string) => {
      const params = new Map<string, string>();
      const PARAM = /\s*([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))\s*;?/g;
      for (let m = PARAM.exec(value); m; m = PARAM.exec(value)) {
        const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
        if (!params.has(m[1].toLowerCase())) params.set(m[1].toLowerCase(), raw);
      }
      return params;
    };
    for (const text of randomTexts(["a", "B", "=", ";", " ", '"', "\\", "x=1", "\n"], 3000, 10)) {
      expect(headerParams(`t; ${text}`).params).toEqual(before(` ${text}`));
    }
  });

  it("finds the parts of many pictures among many parts", () => {
    const parts = Array.from({ length: MHTML_LIMITS.parts - 1 }, (_, i) => ({
      type: "image/png",
      location: `file:///C:/Notes_files/f${i}/image.png`,
      encoding: "base64" as const,
      body: PNG_BASE64,
    }));
    const archive = readMhtml("many.mht", mhtml([{ type: "text/html", body: "<p>x</p>" }, ...parts]));
    fast(() => {
      for (let i = 0; i < 5000; i++) findPart(archive, `other${i}/image.png`, null);
    });
    expect(findPart(archive, "f7/image.png", null)).toBe(archive.parts[8]);
    expect(findPart(archive, "image.png", null)).toBe(archive.parts[1]);
    expect(findPart(archive, "IMAGE.PNG", null)).toBe(archive.parts[1]);
    expect(findPart(archive, "x/f7/image.png", null)).toBeNull();
  });
});

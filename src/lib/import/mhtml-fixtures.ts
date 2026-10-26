/**
 * Single-file web pages (MHTML) written by hand for the import's tests and its e2e script: a MIME
 * builder, and pages in the shape OneNote's *Export → Single File Web Page* writes them (a
 * `multipart/related` message whose HTML is quoted-printable, its pictures base64 in
 * `<page>_files/` beside it; each page a `direction:ltr;border-width:100%` block holding its
 * title, its date and time, then its outlines; a "Created with OneNote." line at the end).
 */

/** A 1×1 PNG, as base64. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type FixturePart = {
  type: string;
  location?: string;
  id?: string;
  charset?: string;
  encoding?: "base64" | "quoted-printable" | "8bit";
  /** Text (written in UTF-8 unless `bytes`), or base64 when the encoding is base64. */
  body: string;
  /** The body's bytes as they are, for an 8bit part in another character set. */
  bytes?: Uint8Array;
};

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

/** Bytes as quoted-printable, in lines of at most 76 characters (OneNote's and Word's way). */
export function quotedPrintable(bytes: Uint8Array): string {
  const lines: string[] = [];
  let line = "";
  const push = (piece: string) => {
    if (line.length + piece.length > 75) {
      lines.push(`${line}=`);
      line = "";
    }
    line += piece;
  };
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(line);
      line = "";
    } else if (byte === 0x0d) continue;
    else if (byte === 0x3d || byte > 0x7e || (byte < 0x20 && byte !== 0x09)) push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
    else push(String.fromCharCode(byte));
  }
  lines.push(line);
  return lines.join("\r\n");
}

/** An MHTML file of the parts, the first (or `start`) being the page. */
export function mhtml(parts: FixturePart[], { boundary = "----=_NextPart_01DB2A4F.6C1D9E30", start }: { boundary?: string; start?: string } = {}): Uint8Array {
  const encoder = new TextEncoder();
  const out: string[] = [
    "MIME-Version: 1.0",
    `Content-Type: multipart/related;\r\n\tboundary="${boundary}"${start ? `;\r\n\tstart="<${start}>"` : ""};\r\n\ttype="text/html"`,
    "",
    "This document is a Single File Web Page, also known as a Web Archive file.",
    "",
  ];
  for (const part of parts) {
    out.push(`--${boundary}`);
    if (part.location) out.push(`Content-Location: ${part.location}`);
    if (part.id) out.push(`Content-ID: <${part.id}>`);
    out.push(`Content-Transfer-Encoding: ${part.encoding ?? "quoted-printable"}`);
    out.push(`Content-Type: ${part.type}${part.charset ? `; charset="${part.charset}"` : ""}`);
    out.push("");
    const bytes = part.bytes ?? encoder.encode(part.body);
    out.push(part.encoding === "base64" ? part.body.replace(/(.{76})/g, "$1\r\n") : part.encoding === "8bit" ? latin1(bytes) : quotedPrintable(bytes));
  }
  out.push(`--${boundary}--`, "");
  const text = out.join("\r\n");
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

/** One OneNote page's block: its title, the date and time under it, and its outlines (HTML). */
export function oneNotePage({ title, date = "Thursday, October 1, 2026", time = "9:30 AM", outlines }: { title: string; date?: string; time?: string; outlines: string[] }): string {
  return [
    "<div style='direction:ltr;border-width:100%'>",
    "<div style='direction:ltr;margin-top:0in;margin-left:0in;width:6.6in'>",
    "<div style='direction:ltr;margin-top:0in;margin-left:0in;width:2.4in'>",
    `<p style='margin:0in;font-family:"Calibri Light";font-size:20.0pt' lang=en-US>${title}</p>`,
    "</div>",
    "<div style='direction:ltr;margin-top:.0423in;margin-left:0in;width:1.6in'>",
    `<p style='margin:0in;font-size:10.0pt;color:#767676'><span style='font-family:Calibri'>${date}</span></p>`,
    `<p style='margin:0in;font-size:10.0pt;color:#767676'><span style='font-family:Calibri'>${time}</span></p>`,
    "</div>",
    ...outlines.map((html) => `<div style='direction:ltr;margin-top:.4in;margin-left:0in;width:6.6in'>\n${html}\n</div>`),
    "</div>",
    "</div>",
  ].join("\n");
}

/** OneNote's HTML document around page blocks (a page export has one, a section's one per page). */
export function oneNoteHtml(pages: string[], { title = "" }: { title?: string } = {}): string {
  return [
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:dt="uuid:C2F41010-65B3-11d1-A29F-00AA00C14882" xmlns="http://www.w3.org/TR/REC-html40">`,
    "<head>",
    `<meta http-equiv=Content-Type content="text/html; charset=utf-8">`,
    "<meta name=ProgId content=OneNote.File>",
    `<meta name=Generator content="Microsoft OneNote 15">`,
    title ? `<title>${title}</title>` : "",
    "<link id=Main-File rel=Main-File href=Notes.htm>",
    `<link rel=File-List href="Notes_files/filelist.xml">`,
    "<style>p { margin: 0 }</style>",
    "</head>",
    "<body lang=en-US style='font-family:Calibri;font-size:11.0pt'>",
    pages.join("\n\n<br clear=all style='page-break-before:always'>\n\n"),
    "<div>",
    "<p style='margin:0in'>&nbsp;</p>",
    "<p style='text-align:left;margin:0in;font-family:Arial;font-size:9pt;color:#969696;direction:ltr'>Created with OneNote.</p>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** A OneNote export: its HTML at `file:///C:/…/Notes.htm` and the pictures in `Notes_files/`. */
export function oneNoteFile(html: string, images: Record<string, string> = {}): Uint8Array {
  const base = "file:///C:/Users/Ana/AppData/Local/Temp/0D1E1F8B";
  return mhtml([
    { type: "text/html", charset: "utf-8", location: `${base}/Notes.htm`, body: html },
    ...Object.entries(images).map(([name, data]) => ({
      type: name.endsWith(".png") ? "image/png" : "application/octet-stream",
      location: `${base}/Notes_files/${name}`,
      encoding: "base64" as const,
      body: data,
    })),
    { type: "text/xml", charset: "utf-8", location: `${base}/Notes_files/filelist.xml`, body: "<xml xmlns:o=\"urn:schemas-microsoft-com:office:office\"></xml>" },
  ]);
}

import { describe, expect, it } from "vitest";
import { decodeText, decodeTransfer, hasFiles, messageParts } from "./structure";

describe("messageParts", () => {
  it("reads a plain message as its text at part 1", () => {
    const parts = messageParts({ type: "text/plain", size: 120 });
    expect(parts.text).toEqual({ part: "1", size: 120, encoding: "7bit", charset: null });
    expect(parts.html).toBeNull();
    expect(parts.attachments).toEqual([]);
  });

  it("takes the text and the HTML of an alternative, and files beside it", () => {
    const parts = messageParts({
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "multipart/related",
          childNodes: [
            {
              part: "1.1",
              type: "multipart/alternative",
              childNodes: [
                { part: "1.1.1", type: "text/plain", size: 10 },
                { part: "1.1.2", type: "text/html", size: 20 },
              ],
            },
            { part: "1.2", type: "image/png", id: "<logo@x>", disposition: "inline", size: 300 },
          ],
        },
        { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "Teklif.pdf" }, size: 4000 },
        { part: "3", type: "text/plain", disposition: "attachment", dispositionParameters: { filename: "notlar.txt" }, size: 50 },
      ],
    });
    expect(parts.text?.part).toBe("1.1.1");
    expect(parts.html?.part).toBe("1.1.2");
    expect(parts.attachments).toEqual([
      { part: "1.2", name: "attachment", contentType: "image/png", size: 300, contentId: "logo@x", inline: true, encoding: "7bit" },
      { part: "2", name: "Teklif.pdf", contentType: "application/pdf", size: 4000, contentId: null, inline: false, encoding: "7bit" },
      { part: "3", name: "notlar.txt", contentType: "text/plain", size: 50, contentId: null, inline: false, encoding: "7bit" },
    ]);
    expect(hasFiles(parts)).toBe(true);
  });

  it("names a forwarded message after its subject", () => {
    const parts = messageParts({
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain" },
        { part: "2", type: "message/rfc822", envelope: { subject: "Eski teklif" } },
      ],
    });
    expect(parts.attachments[0].name).toBe("Eski teklif.eml");
  });

  it("counts only inline images as no files", () => {
    const parts = messageParts({
      type: "multipart/related",
      childNodes: [
        { part: "1", type: "text/html" },
        { part: "2", type: "image/gif", id: "<a@b>" },
      ],
    });
    expect(hasFiles(parts)).toBe(false);
  });
});

describe("decoding parts", () => {
  it("undoes quoted-printable and reads the charset", () => {
    expect(decodeText(Buffer.from("B=C3=BClten =\r\nmetni"), "quoted-printable", "utf-8")).toBe("Bülten metni");
    expect(decodeText(Buffer.from("=FDstanbul =FEubat", "latin1"), "quoted-printable", "iso-8859-9")).toBe("ıstanbul şubat");
  });

  it("undoes base64 across lines, and falls back to UTF-8 for a charset it doesn't know", () => {
    expect(decodeTransfer(Buffer.from("JVBE\r\nRi0x"), "base64").toString()).toBe("%PDF-1");
    expect(decodeText(Buffer.from("w7xu", "latin1"), "base64", "x-unknown")).toBe("ün");
  });
});

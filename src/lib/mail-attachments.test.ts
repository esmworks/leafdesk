import { describe, expect, it } from "vitest";
import { attachmentForViewer, attachmentType, attachmentUrl } from "./mail-attachments";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("attachmentType", () => {
  it("keeps the type a part was sent with", () => {
    expect(attachmentType({ name: "a.pdf", contentType: "application/pdf", data: bytes("%PDF-1.4") })).toBe("application/pdf");
    expect(attachmentType({ name: "a.docx", contentType: "application/octet-stream", data: bytes("PK") })).toBe("application/octet-stream");
  });

  it("serves a PDF sent as plain bytes as a PDF only when its name and its first bytes say so", () => {
    expect(attachmentType({ name: "Poliçe.PDF ", contentType: "application/octet-stream", data: bytes("%PDF-1.7\n") })).toBe("application/pdf");
    expect(attachmentType({ name: "a.pdf", contentType: "application/octet-stream", data: bytes("<html>") })).toBe("application/octet-stream");
    expect(attachmentType({ name: "a.bin", contentType: "application/octet-stream", data: bytes("%PDF-1.7") })).toBe("application/octet-stream");
    expect(attachmentType({ name: "a.pdf", contentType: "text/html", data: bytes("%PDF-1.7") })).toBe("text/html");
  });
});

describe("attachment addresses", () => {
  it("names the message and part, encoded", () => {
    expect(attachmentUrl("m 1", "1.2")).toBe("/api/mail/attachment?m=m%201&p=1.2");
    expect(attachmentUrl("m", "2", "view=pdf")).toBe("/api/mail/attachment?m=m&p=2&view=pdf");
  });

  it("gives the viewer the file, its download and where its PDF frame and Word preview read it", () => {
    expect(attachmentForViewer("m", { part: "3", name: "teklif.docx", contentType: "application/msword" })).toEqual({
      url: "/api/mail/attachment?m=m&p=3",
      name: "teklif.docx",
      type: "application/msword",
      download: "/api/mail/attachment?m=m&p=3&download=1",
      elsewhere: { pdf: "/api/mail/attachment?m=m&p=3&view=pdf", docx: "/api/mail/attachment/preview?m=m&p=3" },
    });
  });
});

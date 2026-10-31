import { describe, expect, it } from "vitest";
import {
  swapTextSignature,
  textSignature,
  bareMessageId,
  dmarcFailed,
  isAutomated,
  normalizeAddress,
  parseMessageIds,
  providerFor,
  quoteText,
  replySubject,
  rowEmailFromHash,
  rowEmailHash,
} from "./mail";

describe("normalizeAddress", () => {
  it("compares addresses as people write them", () => {
    expect(normalizeAddress(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAddress("mailto:ada@example.com")).toBe("ada@example.com");
    expect(normalizeAddress("<ada@example.com>")).toBe("ada@example.com");
  });

  it("refuses what isn't one address", () => {
    expect(normalizeAddress("ada")).toBeNull();
    expect(normalizeAddress("ada@example")).toBeNull();
    expect(normalizeAddress("a@b.com, c@d.com")).toBeNull();
    expect(normalizeAddress("Ada <ada@example.com>")).toBeNull();
    expect(normalizeAddress(42)).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });
});

describe("message ids", () => {
  it("reads References and In-Reply-To, in order and without brackets", () => {
    expect(parseMessageIds("<a@x.com> <b@y.com>\r\n <c@z.com>")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(parseMessageIds(["<a@x.com>", "<b@y.com>"])).toEqual(["a@x.com", "b@y.com"]);
    expect(parseMessageIds("a@x.com b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseMessageIds(undefined)).toEqual([]);
  });

  it("keeps ids bare", () => {
    expect(bareMessageId(" <a@x.com> ")).toBe("a@x.com");
    expect(bareMessageId("a@x.com")).toBe("a@x.com");
  });
});

describe("replies", () => {
  it("puts Re: in front once", () => {
    expect(replySubject("Offer")).toBe("Re: Offer");
    expect(replySubject("Re: Offer")).toBe("Re: Offer");
    expect(replySubject("YNT: Teklif")).toBe("YNT: Teklif");
    expect(replySubject("AW: Angebot")).toBe("AW: Angebot");
  });

  it("quotes every line under who wrote it", () => {
    expect(quoteText("Hello\r\n> earlier\n", "Ada wrote:")).toBe("Ada wrote:\n> Hello\n>> earlier");
  });
});

describe("providerFor", () => {
  it("knows providers by the address's domain", () => {
    expect(providerFor("ada@gmail.com")?.id).toBe("google");
    expect(providerFor("ada@yandex.com.tr")?.id).toBe("yandex");
    expect(providerFor("ada@example.com")).toBeUndefined();
  });
});

describe("isAutomated", () => {
  it("tells auto-replies and bulk mail", () => {
    expect(isAutomated({ autoSubmitted: "auto-replied" })).toBe(true);
    expect(isAutomated({ autoSubmitted: "no" })).toBe(false);
    expect(isAutomated({ precedence: "bulk" })).toBe(true);
    expect(isAutomated({ precedence: "List" })).toBe(true);
    expect(isAutomated({})).toBe(false);
  });
});

describe("dmarcFailed", () => {
  it("reads the provider's verdict", () => {
    expect(dmarcFailed("mx.google.com; dkim=pass; spf=pass; dmarc=fail (p=REJECT)")).toBe(true);
    expect(dmarcFailed(["mx.google.com; dmarc=pass"])).toBe(false);
    expect(dmarcFailed(undefined)).toBe(false);
  });
});

describe("rowEmailHash", () => {
  it("links to a message and reads the link back", () => {
    expect(rowEmailFromHash(rowEmailHash("0f6c-11"))).toBe("0f6c-11");
    expect(rowEmailFromHash("#comment-1")).toBeNull();
    expect(rowEmailFromHash("#email-<x>")).toBeNull();
  });
});

describe("swapTextSignature", () => {
  const reply = `Teşekkürler${textSignature("Ayşe")}\n\nAli yazdı:\n> Merhaba`;

  it("changes a signature in its place, or takes it out", () => {
    expect(swapTextSignature(reply, "Ayşe", "Ayşe Yılmaz\nSatış")).toBe("Teşekkürler\n\n-- \nAyşe Yılmaz\nSatış\n\nAli yazdı:\n> Merhaba");
    expect(swapTextSignature(reply, "Ayşe", null)).toBe("Teşekkürler\n\nAli yazdı:\n> Merhaba");
    expect(swapTextSignature("Fiyat $& ekte\n\n-- \nA", "A", "$1 B")).toBe("Fiyat $& ekte\n\n-- \n$1 B");
  });

  it("adds one above the quote or at the end only where none was taken out", () => {
    expect(swapTextSignature("Teşekkürler\n\nAli yazdı:\n> Merhaba", null, "Ayşe")).toBe(reply);
    expect(swapTextSignature("Merhaba\n", null, "Ayşe")).toBe("Merhaba\n\n-- \nAyşe");
    expect(swapTextSignature("İmzasız", "Ayşe", "Ali")).toBe("İmzasız");
  });
});

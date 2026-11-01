import { describe, expect, it } from "vitest";
import { bimiLocation, logoDomain, logoWidth, organizationDomain, plainSvg, senderAuth, sniffLogo } from "./sender-marks";

describe("senderAuth", () => {
  const gmailBox = { imapHost: "imap.gmail.com", auth: "google" };
  const microsoftBox = { imapHost: "outlook.office365.com", auth: "microsoft" };
  const ownBox = { imapHost: "mail.3e.com.tr", auth: "password" };
  const gmail = "mx.google.com; dkim=pass header.i=@vatan.com; spf=pass smtp.mailfrom=vatan.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=vatan.com";

  it("passes when the mailbox's provider checked the domain the mail is from", () => {
    expect(senderAuth([gmail], "kampanya@vatan.com", gmailBox)).toBe("pass");
    expect(senderAuth([gmail], "Kampanya@VATAN.com", gmailBox)).toBe("pass");
    expect(senderAuth(["spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=vatan.com; dkim=pass; dmarc=pass action=none header.from=vatan.com;compauth=pass reason=100"], "a@vatan.com", microsoftBox)).toBe("pass");
  });

  it("doesn't pass for another domain than the one checked", () => {
    expect(senderAuth([gmail], "info@kuveytturk.com.tr", gmailBox)).toBe("none");
    expect(senderAuth(["mx.google.com; dmarc=pass header.from=sub.vatan.com"], "a@vatan.com", gmailBox)).toBe("none");
  });

  it("goes only by the header the mailbox's provider wrote, never one a sender made up", () => {
    // Another provider's own server can't be told apart from a name a sender wrote.
    expect(senderAuth(["mx1.3e.com.tr; dmarc=pass header.from=vatan.com"], "a@vatan.com", ownBox)).toBe("none");
    // A server that writes none passes the sender's own on, as the first.
    expect(senderAuth(["mx.example.com; dmarc=pass header.from=bank.com"], "a@bank.com", ownBox)).toBe("none");
    expect(senderAuth(["mx.example.com; dmarc=pass header.from=bank.com"], "a@bank.com", gmailBox)).toBe("none");
    expect(senderAuth(["dmarc=pass header.from=bank.com"], "a@bank.com", gmailBox)).toBe("none");
    expect(senderAuth(["dmarc=pass header.from=bank.com"], "a@bank.com", ownBox)).toBe("none");
    expect(senderAuth(["mx.google.com; dmarc=pass header.from=bank.com"], "a@bank.com", microsoftBox)).toBe("none");
    expect(senderAuth(["mx.google.com; spf=none", "evil; dmarc=pass header.from=bank.com"], "a@bank.com", gmailBox)).toBe("none");
  });

  it("fails on a failure in any header", () => {
    expect(senderAuth([gmail, "mx; dmarc=fail header.from=vatan.com"], "a@vatan.com", gmailBox)).toBe("fail");
    expect(senderAuth(["mx; dmarc=quarantine header.from=bank.com"], "a@bank.com", ownBox)).toBe("fail");
  });

  it("has nothing to go by without the header", () => {
    expect(senderAuth(undefined, "a@vatan.com", gmailBox)).toBe("none");
    expect(senderAuth([], "a@vatan.com", gmailBox)).toBe("none");
    expect(senderAuth([gmail], "", gmailBox)).toBe("none");
  });
});

describe("logoDomain", () => {
  it("takes an organization's domain but not a public mail service's", () => {
    expect(logoDomain("Info@E.IstExpo.com")).toBe("e.istexpo.com");
    expect(logoDomain("someone@gmail.com")).toBeNull();
    expect(logoDomain("nobody")).toBeNull();
    expect(logoDomain("a@localhost")).toBeNull();
    expect(logoDomain("a@x/../y.com")).toBeNull();
  });
});

describe("organizationDomain", () => {
  it("keeps two labels, or three under a country's second level", () => {
    expect(organizationDomain("e.istexpo.com")).toBe("istexpo.com");
    expect(organizationDomain("bilgilendirme.kuveytturk.com.tr")).toBe("kuveytturk.com.tr");
    expect(organizationDomain("mail.bbc.co.uk")).toBe("bbc.co.uk");
    expect(organizationDomain("vatan.com")).toBe("vatan.com");
    expect(organizationDomain("news.example.de")).toBe("example.de");
  });
});

describe("bimiLocation", () => {
  it("reads the logo's https address", () => {
    expect(bimiLocation("v=BIMI1; l=https://cdn.example.com/logo.svg; a=https://cdn.example.com/vmc.pem")).toBe("https://cdn.example.com/logo.svg");
    expect(bimiLocation("v=bimi1;l=https://x.example/l.svg")).toBe("https://x.example/l.svg");
  });

  it("refuses other records and addresses", () => {
    expect(bimiLocation("v=spf1 include:_spf.google.com ~all")).toBeNull();
    expect(bimiLocation("v=BIMI1; l=")).toBeNull();
    expect(bimiLocation("v=BIMI1; l=http://x.example/l.svg")).toBeNull();
    expect(bimiLocation("v=BIMI1; l=https://user:pw@x.example/l.svg")).toBeNull();
  });
});

describe("sniffLogo and logoWidth", () => {
  const png = (width: number) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes[19] = width & 255;
    bytes[18] = width >> 8;
    return bytes;
  };
  const ico = (...widths: number[]) => {
    const bytes = new Uint8Array(6 + widths.length * 16);
    bytes.set([0, 0, 1, 0, widths.length, 0]);
    widths.forEach((w, i) => (bytes[6 + i * 16] = w));
    return bytes;
  };

  it("knows formats by their first bytes", () => {
    expect(sniffLogo(png(180))).toBe("png");
    expect(sniffLogo(ico(16))).toBe("ico");
    expect(sniffLogo(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(sniffLogo(new TextEncoder().encode("<html><body>"))).toBeNull();
  });

  it("reads the width of a PNG and an icon file's widest picture (0 is 256)", () => {
    expect(logoWidth(png(180), "png")).toBe(180);
    expect(logoWidth(ico(16, 32), "ico")).toBe(32);
    expect(logoWidth(ico(16, 0), "ico")).toBe(256);
    expect(logoWidth(new Uint8Array(4), "jpeg")).toBeNull();
  });
});

describe("plainSvg", () => {
  it("takes a plain drawing, with links inside it", () => {
    expect(plainSvg('<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps"><title>V</title><path fill="url(#g)" d="M0 0h10v10z"/><use href="#p"/></svg>')).toBe(true);
  });

  it("refuses scripts, handlers and anything it would load", () => {
    expect(plainSvg('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(plainSvg('<svg onload="alert(1)"></svg>')).toBe(false);
    expect(plainSvg('<svg><foreignObject><div/></foreignObject></svg>')).toBe(false);
    expect(plainSvg('<svg><image href="https://x.example/a.png"/></svg>')).toBe(false);
    expect(plainSvg('<svg><use href="https://x.example/s.svg#a"/></svg>')).toBe(false);
    expect(plainSvg('<svg><rect style="fill:url(https://x.example/t)"/></svg>')).toBe(false);
    expect(plainSvg('<svg><a href="javascript:alert(1)"><rect/></a></svg>')).toBe(false);
    expect(plainSvg("<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg>&x;</svg>")).toBe(false);
    expect(plainSvg("<html></html>")).toBe(false);
  });
});

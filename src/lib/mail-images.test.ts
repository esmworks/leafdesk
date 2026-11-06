import { describe, expect, it } from "vitest";
import { imagesShown, imagesWanted, sameOrganization } from "./mail-images";

const choice = { asked: false, rememberedCopy: false, trustedSender: false, mailboxAddress: "erhan@gunaysogutma.com.tr", fromAddress: "simay@example.com" };

describe("mail images", () => {
  it("leaves images out unless asked, trusted or from the mailbox's own organization", () => {
    expect(imagesWanted(choice)).toBeNull();
    expect(imagesWanted({ ...choice, asked: true })).toBe("asked");
    expect(imagesWanted({ ...choice, trustedSender: true })).toBe("sender");
    expect(imagesWanted({ ...choice, fromAddress: "Simay@GunaySogutma.com.tr" })).toBe("domain");
    expect(imagesWanted({ ...choice, asked: true, trustedSender: true })).toBe("asked");
    expect(imagesWanted({ ...choice, rememberedCopy: true, trustedSender: true })).toBe("copy");
  });

  it("doesn't take a public mail service for an organization", () => {
    expect(sameOrganization("me@gmail.com", "anyone@gmail.com")).toBe(false);
    expect(sameOrganization("me@gunaysogutma.com.tr", "sefa@gunaysogutma.com.tr")).toBe(true);
    expect(sameOrganization("me@gunaysogutma.com.tr", "x@mail.gunaysogutma.com.tr")).toBe(false);
    expect(sameOrganization("", "")).toBe(false);
  });

  it("drops trust and a copy's memory, but not the owner's own request, when the sender failed the provider's check", () => {
    expect(imagesShown("sender", "fail")).toBeNull();
    expect(imagesShown("copy", "fail")).toBeNull();
    expect(imagesShown("domain", "fail")).toBeNull();
    expect(imagesShown("asked", "fail")).toBe("asked");
    expect(imagesShown("sender", "none")).toBe("sender");
    expect(imagesShown("copy", "none")).toBe("copy");
    expect(imagesShown(null, "pass")).toBeNull();
  });

  it("shows the mailbox's own domain's images only when the provider vouched for the sender", () => {
    expect(imagesShown("domain", "none")).toBeNull();
    expect(imagesShown("domain", "pass")).toBe("domain");
  });
});

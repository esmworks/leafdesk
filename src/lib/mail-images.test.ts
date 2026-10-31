import { describe, expect, it } from "vitest";
import { imagesShown, imagesWanted, sameOrganization } from "./mail-images";

const choice = { asked: false, trustedSender: false, mailboxAddress: "erhan@gunaysogutma.com.tr", fromAddress: "simay@example.com" };

describe("mail images", () => {
  it("leaves images out unless asked, trusted or from the mailbox's own organization", () => {
    expect(imagesWanted(choice)).toBeNull();
    expect(imagesWanted({ ...choice, asked: true })).toBe("asked");
    expect(imagesWanted({ ...choice, trustedSender: true })).toBe("sender");
    expect(imagesWanted({ ...choice, fromAddress: "Simay@GunaySogutma.com.tr" })).toBe("domain");
    expect(imagesWanted({ ...choice, asked: true, trustedSender: true })).toBe("asked");
  });

  it("doesn't take a public mail service for an organization", () => {
    expect(sameOrganization("me@gmail.com", "anyone@gmail.com")).toBe(false);
    expect(sameOrganization("me@gunaysogutma.com.tr", "sefa@gunaysogutma.com.tr")).toBe(true);
    expect(sameOrganization("me@gunaysogutma.com.tr", "x@mail.gunaysogutma.com.tr")).toBe(false);
    expect(sameOrganization("", "")).toBe(false);
  });

  it("drops trust, but not the owner's own request, when the sender failed the provider's check", () => {
    expect(imagesShown("sender", true)).toBeNull();
    expect(imagesShown("domain", true)).toBeNull();
    expect(imagesShown("asked", true)).toBe("asked");
    expect(imagesShown("sender", false)).toBe("sender");
    expect(imagesShown(null, false)).toBeNull();
  });
});

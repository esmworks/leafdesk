import { describe, expect, it } from "vitest";
import { ruleDomain, ruleFor, ruleSender, sectionOf, senderDomain, type SenderRuleKind } from "./mail-senders";

describe("senderDomain and ruleDomain", () => {
  it("reads the domain in lower case", () => {
    expect(senderDomain("Ada@Example.COM")).toBe("example.com");
    expect(senderDomain("no-domain")).toBeNull();
    expect(senderDomain("ada@localhost")).toBeNull();
  });

  it("names no public mail service for everyone there", () => {
    expect(ruleDomain("ada@example.com")).toBe("example.com");
    expect(ruleDomain("ada@gmail.com")).toBeNull();
  });
});

describe("ruleSender", () => {
  it("keeps an address in lower case", () => {
    expect(ruleSender("  News@Shop.Example ", "other")).toBe("news@shop.example");
    expect(ruleSender("news@shop.example", "block")).toBe("news@shop.example");
  });

  it("keeps a domain for focus and other, never for blocking", () => {
    expect(ruleSender("@Shop.Example", "other")).toBe("shop.example");
    expect(ruleSender("shop.example", "focus")).toBe("shop.example");
    expect(ruleSender("shop.example", "block")).toBeNull();
  });

  it("refuses public mail services' domains and what isn't an address", () => {
    expect(ruleSender("gmail.com", "other")).toBeNull();
    expect(ruleSender("Ada <ada@example.com>", "other")).toBeNull();
    expect(ruleSender("ada@", "block")).toBeNull();
    expect(ruleSender("localhost", "focus")).toBeNull();
    expect(ruleSender(42, "focus")).toBeNull();
    expect(ruleSender(`${"a".repeat(320)}@example.com`, "focus")).toBeNull();
  });
});

describe("ruleFor and sectionOf", () => {
  const rules = new Map<string, SenderRuleKind>([
    ["example.com", "other"],
    ["boss@example.com", "focus"],
    ["spam@shop.example", "block"],
  ]);

  it("takes the address's own rule before its domain's", () => {
    expect(ruleFor("Boss@Example.com", rules)).toBe("focus");
    expect(ruleFor("news@example.com", rules)).toBe("other");
    expect(ruleFor("spam@shop.example", rules)).toBe("block");
    expect(ruleFor("ada@elsewhere.example", rules)).toBeNull();
  });

  it("puts what machines send in Other unless a rule says otherwise", () => {
    expect(sectionOf(false, null)).toBe("focus");
    expect(sectionOf(true, null)).toBe("other");
    expect(sectionOf(true, "focus")).toBe("focus");
    expect(sectionOf(false, "other")).toBe("other");
    expect(sectionOf(false, "block")).toBe("other");
  });
});

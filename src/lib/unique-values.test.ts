import { describe, expect, it } from "vitest";
import { canBeUnique, uniqueValueKey } from "./unique-values";

describe("uniqueValueKey", () => {
  it("folds text, emails and links by case and outer spaces", () => {
    expect(uniqueValueKey("text", "  Ada Lovelace ")).toBe("ada lovelace");
    expect(uniqueValueKey("email", "ADA@example.test")).toBe(uniqueValueKey("email", "ada@example.test "));
    expect(uniqueValueKey("url", "https://Example.test/A")).toBe("https://example.test/a");
  });

  it("compares phone numbers by their digits and +", () => {
    expect(uniqueValueKey("phone", "+90 (555) 123-45-67")).toBe("+905551234567");
  });

  it("compares numbers by amount", () => {
    expect(uniqueValueKey("number", 1)).toBe(uniqueValueKey("number", 1.0));
    expect(uniqueValueKey("number", 1.5)).not.toBe(uniqueValueKey("number", 1));
  });

  it("gives empty values no key", () => {
    expect(uniqueValueKey("text", "   ")).toBeNull();
    expect(uniqueValueKey("text", null)).toBeNull();
    expect(uniqueValueKey("phone", "-")).toBeNull();
    expect(uniqueValueKey("number", "x")).toBeNull();
  });
});

describe("canBeUnique", () => {
  it("takes the types whose values compare as one", () => {
    expect(["text", "number", "email", "url", "phone"].every(canBeUnique)).toBe(true);
    expect(canBeUnique("select")).toBe(false);
    expect(canBeUnique("date")).toBe(false);
  });
});

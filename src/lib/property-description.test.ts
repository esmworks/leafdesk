import { describe, expect, it } from "vitest";
import { MAX_PROPERTY_DESCRIPTION, cleanDescription, descriptionLine, propertyDescription } from "./property-description";

describe("property descriptions", () => {
  it("reads a trimmed description, or none", () => {
    expect(propertyDescription({ options: { description: "  Who signs  " } })).toBe("Who signs");
    expect(propertyDescription({ options: {} })).toBe("");
    expect(propertyDescription({ options: { description: 4 } })).toBe("");
    expect(descriptionLine({ options: { description: "One\n\ntwo   three" } })).toBe("One two three");
  });

  it("stores descriptions cleaned and refuses long ones", () => {
    expect(cleanDescription("  a\r\n\r\n\r\n\r\nb ")).toEqual({ ok: true, description: "a\n\nb" });
    expect(cleanDescription("   ")).toEqual({ ok: true, description: null });
    expect(cleanDescription("x".repeat(MAX_PROPERTY_DESCRIPTION))).toEqual({ ok: true, description: "x".repeat(MAX_PROPERTY_DESCRIPTION) });
    expect(cleanDescription("x".repeat(MAX_PROPERTY_DESCRIPTION + 1))).toEqual({ ok: false });
  });
});

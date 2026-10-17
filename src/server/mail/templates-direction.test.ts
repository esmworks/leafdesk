import { describe, expect, it } from "vitest";
import { testEmail } from "./templates";

describe("email direction", () => {
  it("runs right to left for Arabic, Hebrew and Persian", () => {
    for (const locale of ["ar", "he", "fa"] as const) {
      const { html } = testEmail(locale);
      expect(html).toContain(`<html lang="${locale}" dir="rtl">`);
      expect(html).toContain('<body dir="rtl"');
      expect(html).toContain('dir="rtl" align="right"');
      expect(html).toContain("text-align:right;");
    }
  });

  it("adds nothing left to right", () => {
    const { html } = testEmail("en");
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("dir=");
    expect(html).not.toContain("align=\"right\"");
  });
});

import { describe, expect, it } from "vitest";
import { textDirection } from "./text-direction";

describe("textDirection", () => {
  it("follows the first letter", () => {
    expect(textDirection("مرحبا Hello")).toBe("rtl");
    expect(textDirection("Hello مرحبا")).toBe("ltr");
    expect(textDirection("שלום")).toBe("rtl");
    expect(textDirection("سلام دنیا")).toBe("rtl");
    expect(textDirection("日本語")).toBe("ltr");
  });

  it("skips what isn't a letter", () => {
    expect(textDirection("1. — «שלום»")).toBe("rtl");
    expect(textDirection("😀 42 Über")).toBe("ltr");
  });

  it("has none without letters", () => {
    expect(textDirection("")).toBeNull();
    expect(textDirection("123 + 4 = ?")).toBeNull();
  });
});

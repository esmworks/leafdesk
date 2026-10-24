import { describe, expect, it } from "vitest";
import { searchFold } from "./search-fold";

describe("searchFold", () => {
  it("lower-cases and treats the dotted and dotless i alike", () => {
    expect(searchFold("UI Test")).toBe(searchFold("uı test"));
    expect(searchFold("IŞIK")).toBe("işik");
    expect(searchFold("İstanbul")).toBe("istanbul");
    expect(searchFold("I\u0307stanbul")).toBe("istanbul");
    expect(searchFold("ılık")).toBe(searchFold("ILIK"));
    expect(searchFold("Design").includes(searchFold("DES"))).toBe(true);
  });
});

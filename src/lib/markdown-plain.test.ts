import { describe, expect, it } from "vitest";
import { markdownPlain } from "./markdown-plain";

describe("markdownPlain", () => {
  it("drops the marks around and before words", () => {
    expect(markdownPlain("## Summary\n**Checked:** the `Orders` sheet\n- 43 items\n2. Two\n> quoted")).toBe(
      "Summary\nChecked: the Orders sheet\n43 items\nTwo\nquoted",
    );
  });

  it("keeps a link's text and drops rules", () => {
    expect(markdownPlain("See [the run](https://example.com/r) ![chart](a.png)\n---\nend")).toBe("See the run chart\n\nend");
  });

  it("leaves what isn't a mark alone", () => {
    expect(markdownPlain("2 * 3 = 6, file_name_here, -5 °C")).toBe("2 * 3 = 6, file_name_here, -5 °C");
  });
});

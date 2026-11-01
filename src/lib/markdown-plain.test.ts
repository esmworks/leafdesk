import { describe, expect, it } from "vitest";
import { markdownLead, markdownPlain, markdownSummary } from "./markdown-plain";

describe("markdownLead", () => {
  it("keeps whole paragraphs that fit, marks and all", () => {
    expect(markdownLead("Marked **two** rows.\n\n- Row A\n- Row B\n\nA long last paragraph that won't fit.", 40)).toBe("Marked **two** rows.\n\n- Row A\n- Row B");
    expect(markdownLead("Short.", 500)).toBe("Short.");
  });

  it("falls back to the first paragraph's plain words when it alone is too long", () => {
    const out = markdownLead(`**${"word ".repeat(30)}**\n\nMore.`, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).not.toContain("**");
  });
});

describe("markdownSummary", () => {
  it("takes the first paragraph as one line of plain words", () => {
    expect(markdownSummary("Marked **two** rows Late.\nBoth were due [last week](https://x.test).\n\n- Row A\n- Row B")).toBe("Marked two rows Late. Both were due last week.");
  });

  it("passes over headings and rules before the first words", () => {
    expect(markdownSummary("## Daily report\n\n---\n\nNothing needs you today.\n\nDetails follow.")).toBe("Nothing needs you today.");
    expect(markdownSummary("# Report\nAll rows are up to date.")).toBe("All rows are up to date.");
  });

  it("cuts a long paragraph short, never inside a character", () => {
    const long = markdownSummary(`${"word ".repeat(80)}end`, 200);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
    const emoji = markdownSummary(`${"a".repeat(198)}😀😀`, 200);
    expect(emoji).toBe(`${"a".repeat(198)}…`);
  });

  it("is empty for an empty answer, and keeps a lone heading", () => {
    expect(markdownSummary("")).toBe("");
    expect(markdownSummary("## Done")).toBe("Done");
  });
});

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

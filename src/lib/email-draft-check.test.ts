import { describe, expect, it } from "vitest";
import { checkEmailDraft, explainEmailDraftProblems } from "./email-draft-check";

const problems = (subject: string, text: string) => {
  const check = checkEmailDraft({ subject, text });
  return check.ok ? [] : check.problems.map((p) => p.problem);
};

describe("checkEmailDraft", () => {
  it("passes a finished plain-text message", () => {
    expect(problems("Your quote", "Hello Selin,\n\nThe quote is 18,500 (VAT included).\nWrite to me at <erhan@example.com>.\n\nBest regards,\nErhan")).toEqual([]);
    expect(problems("Re: Offer", "Prices: 3 < 5 and 5 > 3 - see the attached list.\n* one\n* two")).toEqual([]);
  });

  it("refuses gaps left to fill and bracketed source numbers", () => {
    for (const text of ["Hello {{first_name}},", "Best,\n[Your Name]", "We deliver on [insert date].", "As the manual says [1], close the door.", "See [Company] for details"]) {
      expect(problems("Hi", text), text).toContain("placeholder");
    }
  });

  it("refuses Markdown", () => {
    for (const text of ["This is **important**.", "# Offer\nHello", "Read [the terms](https://example.com/terms).", "| a | b |\n|---|---|\n| 1 | 2 |", "```\ncode\n```"]) {
      expect(problems("Hi", text), text).toContain("markdown");
    }
  });

  it("refuses HTML and the app's own ids and markup", () => {
    expect(problems("Hi", "<p>Hello</p>")).toContain("html");
    expect(problems("Hi", "Line<br/>break")).toContain("html");
    expect(problems("Hi", "Your ticket 5d1f9085-43c6-4cb9-a4bd-09ee30926157 is closed.")).toContain("internal");
    expect(problems("Hi", "See /w/ws-1/p/row-1 for more.")).toContain("internal");
    expect(problems("Hi", "x <!-- leafdesk:page-link -->")).toContain("internal");
  });

  it("refuses an empty text and a subject on two lines", () => {
    expect(problems("Hi", "  \n ")).toEqual(["emptyText"]);
    expect(problems("Hi\nthere", "Hello")).toEqual(["subjectLineBreak"]);
  });

  it("checks the subject too, and explains what it found", () => {
    const check = checkEmailDraft({ subject: "Offer for [Company]", text: "Hello" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(explainEmailDraftProblems(check)).toMatch(/gap to fill .*found: "Offer for \[Company\]"/);
  });
});

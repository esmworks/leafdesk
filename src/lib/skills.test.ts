import { describe, expect, it } from "vitest";
import { describeSkill, MAX_SKILL_NAME, skillMarkdown, skillNames, skillSlug } from "./skills";

describe("skillSlug", () => {
  it("makes lowercase words joined by hyphens", () => {
    expect(skillSlug("Review a feature proposal")).toBe("review-a-feature-proposal");
    expect(skillSlug("  PRD — from raw notes!  ")).toBe("prd-from-raw-notes");
  });

  it("drops accents, Turkish letters included", () => {
    expect(skillSlug("Haftalık iş özeti")).toBe("haftalik-is-ozeti");
    expect(skillSlug("İçerik çevirisi")).toBe("icerik-cevirisi");
    expect(skillSlug("Größe prüfen")).toBe("grosse-prufen");
    expect(skillSlug("Résumé de réunion")).toBe("resume-de-reunion");
  });

  it("falls back to skill when nothing is left", () => {
    expect(skillSlug("")).toBe("skill");
    expect(skillSlug("🧭 ✨")).toBe("skill");
    expect(skillSlug("日本語")).toBe("skill");
  });

  it("keeps to the longest name without a trailing hyphen", () => {
    const slug = skillSlug("word ".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(MAX_SKILL_NAME);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("skillNames", () => {
  it("numbers names already taken, in the order given", () => {
    const names = skillNames([
      { id: "a", title: "Weekly digest" },
      { id: "b", title: "Weekly  Digest" },
      { id: "c", title: "Weekly digest" },
      { id: "d", title: "Other" },
    ]);
    expect([...names.values()]).toEqual(["weekly-digest", "weekly-digest-2", "weekly-digest-3", "other"]);
  });

  it("doesn't collide with a title that already ends in a number", () => {
    const names = skillNames([
      { id: "a", title: "Plan 2" },
      { id: "b", title: "Plan" },
      { id: "c", title: "Plan" },
    ]);
    expect(names.get("c")).toBe("plan-3");
  });

  it("stays within the longest name when numbering", () => {
    const long = "x".repeat(80);
    const names = skillNames([
      { id: "a", title: long },
      { id: "b", title: long },
    ]);
    expect(names.get("b")?.length).toBeLessThanOrEqual(MAX_SKILL_NAME);
    expect(names.get("b")?.endsWith("-2")).toBe(true);
  });
});

describe("describeSkill", () => {
  it("prefers the written description", () => {
    expect(describeSkill("  Use for proposals. ", "Body")).toEqual({ description: "Use for proposals.", described: true });
  });

  it("takes the start of the body, on one line, cut at a word", () => {
    const body = `First line\n\n${"word ".repeat(100)}`;
    const { description, described } = describeSkill("", body);
    expect(described).toBe(false);
    expect(description.startsWith("First line word")).toBe(true);
    expect(description.endsWith("…")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(200);
  });
});

describe("skillMarkdown", () => {
  it("writes front matter and the instructions", () => {
    expect(skillMarkdown({ name: "review", description: 'Check "risky" parts:\nfirst', body: "# Steps\n\n1. Read\n" })).toBe(
      '---\nname: review\ndescription: "Check \\"risky\\" parts: first"\n---\n\n# Steps\n\n1. Read\n',
    );
  });
});

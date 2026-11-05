import { describe, expect, it } from "vitest";
import { findSkills, frontMatter, parseSkillMarkdown, titleFromName } from "./skill-import";
import { MAX_SKILL_DESCRIPTION, skillMarkdown } from "./skills";

describe("parseSkillMarkdown", () => {
  it("reads what Export as SKILL.md writes", () => {
    const file = skillMarkdown({ name: "release-notes", description: 'Write release notes: "short", by area.', body: "## Steps\n\n1. Read the merged PRs." });
    expect(parseSkillMarkdown(file, "x")).toEqual({
      name: "release-notes",
      description: 'Write release notes: "short", by area.',
      title: "Release notes",
      body: "## Steps\n\n1. Read the merged PRs.",
    });
  });

  it("takes the title from a first heading, taking it out of the body", () => {
    const parsed = parseSkillMarkdown("---\nname: triage\ndescription: Sort requests\n---\n\n# Triage a request\n\nAsk who it is for.\n", "x");
    expect(parsed.title).toBe("Triage a request");
    expect(parsed.body).toBe("Ask who it is for.");
  });

  it("reads quoted, folded and literal values, and other keys stay out of the way", () => {
    const meta = frontMatter([
      "name: 'it''s-mine'",
      "description: >",
      "  Use when a customer",
      "  asks for a refund.",
      "license: MIT",
      "metadata:",
      "  version: 2",
      "allowed-tools: Read, Grep",
      "notes: |",
      "  line one",
      "  line two",
    ]);
    expect(meta.get("name")).toBe("it's-mine");
    expect(meta.get("description")).toBe("Use when a customer asks for a refund.");
    expect(meta.get("notes")).toBe("line one\nline two");
    expect(meta.get("license")).toBe("MIT");
  });

  it("goes on with a plain value on indented lines", () => {
    expect(frontMatter(["description: Use when", "  writing a summary"]).get("description")).toBe("Use when writing a summary");
  });

  it("brings a Markdown file without front matter, named by its file, and cuts a long description", () => {
    expect(parseSkillMarkdown("﻿Just do it.\r\n", "weekly-report")).toEqual({ name: null, description: "", title: "Weekly report", body: "Just do it." });
    const long = parseSkillMarkdown(`---\ndescription: ${"x".repeat(MAX_SKILL_DESCRIPTION + 50)}\n---\nBody`, "s");
    expect(long.description).toHaveLength(MAX_SKILL_DESCRIPTION);
  });

  it("leaves a front matter that never ends in the body", () => {
    expect(parseSkillMarkdown("---\nname: x\nNo end", "f").body).toBe("---\nname: x\nNo end");
  });
});

describe("titleFromName", () => {
  it("makes a name readable", () => {
    expect(titleFromName("pdf_form-filling")).toBe("Pdf form filling");
    expect(titleFromName("")).toBe("");
  });
});

describe("findSkills", () => {
  it("finds every SKILL.md with the files of its own folder, not another skill's nor the top level's", () => {
    const found = findSkills([
      "README.md",
      "review/SKILL.md",
      "review/checklist.md",
      "review/scripts/lint.sh",
      "review/inner/SKILL.md",
      "review/inner/notes.txt",
      "notes/Skill.md",
    ]);
    expect(found).toEqual([
      { path: "notes/Skill.md", fallback: "notes", files: [] },
      { path: "review/inner/SKILL.md", fallback: "inner", files: ["review/inner/notes.txt"] },
      { path: "review/SKILL.md", fallback: "review", files: ["review/checklist.md", "review/scripts/lint.sh"] },
    ]);
  });

  it("takes a loose SKILL.md without files", () => {
    expect(findSkills(["SKILL.md", "other.txt"])).toEqual([{ path: "SKILL.md", fallback: "skill", files: [] }]);
  });

  it("brings top-level Markdown files as skills when there is no SKILL.md", () => {
    expect(findSkills(["b.md", "a.markdown", "docs/c.md", "x.txt"])).toEqual([
      { path: "a.markdown", fallback: "a", files: [] },
      { path: "b.md", fallback: "b", files: [] },
    ]);
  });
});

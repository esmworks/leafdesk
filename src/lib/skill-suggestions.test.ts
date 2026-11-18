import { describe, expect, it } from "vitest";
import { readSkillSuggestions, SUGGEST_INSTRUCTIONS_CHARS, SUGGEST_MAX, SUGGEST_NAME_CHARS, suggestionLines } from "./skill-suggestions";

describe("suggestionLines", () => {
  it("lists questions and page titles under their headings, one line each", () => {
    const { text, questions, pages } = suggestionLines(["Write release notes\nfor v2", "  "], ["Weekly report"], 10_000);
    expect(text).toBe("Questions the person asked the AI chat, newest first:\n- Write release notes for v2\n\nTitles of pages the person edited, newest first:\n- Weekly report");
    expect([questions, pages]).toEqual([1, 1]);
  });

  it("cuts long questions and stops when the room is used", () => {
    const long = "x".repeat(1_000);
    const { text, questions } = suggestionLines([long, "second", "third"], [], 340);
    expect(text).toContain("…");
    expect(questions).toBe(1);
    expect(text.length).toBeLessThanOrEqual(340);
  });

  it("is empty without anything to read", () => {
    expect(suggestionLines([], [], 1_000)).toEqual({ text: "", questions: 0, pages: 0 });
  });
});

describe("readSkillSuggestions", () => {
  it("reads the skills of the answer, in a code fence too", () => {
    const answer = '```json\n{"skills":[{"name":"Release notes","when":"Before a release","instructions":"1. List changes\\n2. Group them"}]}\n```';
    expect(readSkillSuggestions(answer)).toEqual([
      { id: "1", title: "Release notes", description: "Before a release", instructions: "1. List changes\n2. Group them" },
    ]);
  });

  it("drops entries without a title or instructions, repeats and skills the person has", () => {
    const answer = JSON.stringify({
      skills: [
        { name: "A", when: "x", instructions: "do a" },
        { name: "a", when: "again", instructions: "do a again" },
        { name: "", instructions: "no title" },
        { name: "No body", instructions: "  " },
        { name: "Have", instructions: "already there" },
        "junk",
        null,
        { name: "B", instructions: "do b" },
      ],
    });
    expect(readSkillSuggestions(answer, ["have"]).map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("keeps at most five and cuts what is too long", () => {
    const skills = Array.from({ length: 9 }, (_, i) => ({ name: `Skill ${i} ${"n".repeat(200)}`, when: "w".repeat(900), instructions: "i".repeat(9_000) }));
    const found = readSkillSuggestions(JSON.stringify({ skills }));
    expect(found).toHaveLength(SUGGEST_MAX);
    expect(found[0].title.length).toBeLessThanOrEqual(SUGGEST_NAME_CHARS);
    expect(found[0].description.length).toBeLessThanOrEqual(300);
    expect(found[0].instructions.length).toBe(SUGGEST_INSTRUCTIONS_CHARS);
  });

  it("is empty for an answer that isn't the JSON asked for", () => {
    expect(readSkillSuggestions("I could not find anything.")).toEqual([]);
    expect(readSkillSuggestions('{"skills": "none"}')).toEqual([]);
  });
});

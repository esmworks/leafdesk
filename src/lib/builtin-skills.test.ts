import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { BUILTIN_SKILL_KEYS, builtinSkills } from "./builtin-skills";
import { MAX_SKILL_DESCRIPTION } from "./skills";

/** The Markdown outline of a body: its headings' levels and its list markers, in order. */
const outline = (markdown: string) =>
  markdown
    .split("\n")
    .map((line) => /^(#+ |\s*\d+\. |\s*- )/.exec(line)?.[1].replace(/\d+/, "1"))
    .filter(Boolean);

describe("built-in skills", () => {
  it.each(LOCALES)("%s: every skill, titled, described and with the English body's outline", async (locale) => {
    const english = await builtinSkills("en");
    const skills = await builtinSkills(locale);
    expect(skills.map((s) => s.key)).toEqual([...BUILTIN_SKILL_KEYS]);
    expect(new Set(skills.map((s) => s.title)).size).toBe(skills.length);
    for (const [i, skill] of skills.entries()) {
      expect(skill.title.trim(), `${locale}: ${skill.key}`).not.toBe("");
      expect(skill.description.trim(), `${locale}: ${skill.key}`).not.toBe("");
      expect(skill.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION);
      expect(outline(skill.markdown), `${locale}: ${skill.key}`).toEqual(outline(english[i].markdown));
    }
  });

  it("uses English for unknown languages", async () => {
    expect((await builtinSkills("xx"))[0].title).toBe("Wrap up meeting notes");
    expect((await builtinSkills("tr"))[0].title).toBe("Toplantı notunu toparla");
  });
});

import { describe, expect, it } from "vitest";
import { cleanPromptName, cleanPromptText, MAX_PROMPT_NAME, MAX_PROMPT_TEXT, savedPromptProblem, suggestPromptName } from "./ai-saved-prompts";

describe("saved AI prompts", () => {
  it("keep names on one line and prompts trimmed", () => {
    expect(cleanPromptName("  Tone\n of   voice ")).toBe("Tone of voice");
    expect(cleanPromptName(42)).toBe("");
    expect(cleanPromptText("  First line\r\nsecond  ")).toBe("First line\nsecond");
    expect(cleanPromptText(null)).toBe("");
  });

  it("need a name and a prompt within the limits", () => {
    expect(savedPromptProblem("Tone", "Make it friendlier")).toBeNull();
    expect(savedPromptProblem("", "x")).toBe("emptyName");
    expect(savedPromptProblem("Tone", "")).toBe("emptyPrompt");
    expect(savedPromptProblem("x".repeat(MAX_PROMPT_NAME + 1), "x")).toBe("nameTooLong");
    expect(savedPromptProblem("Tone", "x".repeat(MAX_PROMPT_TEXT + 1))).toBe("promptTooLong");
    expect(savedPromptProblem("x".repeat(MAX_PROMPT_NAME), "x".repeat(MAX_PROMPT_TEXT))).toBeNull();
    // Renaming checks the name only.
    expect(savedPromptProblem("New name")).toBeNull();
    expect(savedPromptProblem("")).toBe("emptyName");
  });

  it("suggest a name from the prompt's first words", () => {
    expect(suggestPromptName("Make it shorter")).toBe("Make it shorter");
    const long = suggestPromptName("Rewrite this as a short friendly email to a customer who waited too long");
    expect(long.endsWith("…") && long.length <= 41 && !long.includes("  ")).toBe(true);
    expect(long.startsWith("Rewrite this as a short friendly email")).toBe(true);
  });
});

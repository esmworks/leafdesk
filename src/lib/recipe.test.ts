import { describe, expect, it } from "vitest";
import { RECIPE_JSON_LD } from "@/server/web-clip-fixtures";
import { cleanText, findRecipe, formatDuration, parseDuration, parseJsonLd } from "./recipe";

describe("findRecipe", () => {
  it("reads a recipe in a @graph, with sections of steps", () => {
    const recipe = findRecipe([RECIPE_JSON_LD]);
    expect(recipe).toEqual({
      name: "Lentil Soup with Lemon",
      yield: "4 servings",
      prepTime: { days: 0, hours: 0, minutes: 15 },
      cookTime: { days: 0, hours: 0, minutes: 45 },
      totalTime: { days: 0, hours: 1, minutes: 0 },
      ingredients: ["1 cup red lentils", "1 onion, chopped", "2 tbsp olive oil", "Juice of 1 lemon & its zest"],
      instructions: [
        { name: "The soup", steps: ["Warm the oil and soften the onion.", "Add the lentils and 1 litre of water; simmer for 40 minutes."] },
        { name: "To serve", steps: ["Stir in the lemon juice and zest."] },
      ],
    });
  });

  it("finds the recipe as the main entity of a page, among other scripts", () => {
    const page = { "@type": "WebPage", mainEntity: { "@type": "http://schema.org/Recipe", name: "Toast", recipeIngredient: "Bread\nButter" } };
    const recipe = findRecipe([{ "@type": "Organization" }, undefined, page]);
    expect(recipe?.name).toBe("Toast");
    expect(recipe?.ingredients).toEqual(["Bread", "Butter"]);
    expect(recipe?.instructions).toEqual([]);
  });

  it("reads steps written as one text, a list of texts, or HTML", () => {
    const base = { "@type": "Recipe", name: "R", recipeIngredient: ["x"] };
    expect(findRecipe([{ ...base, recipeInstructions: "Mix.\nBake.\n" }])?.instructions).toEqual([{ name: null, steps: ["Mix.", "Bake."] }]);
    expect(findRecipe([{ ...base, recipeInstructions: ["Mix.", "Bake."] }])?.instructions).toEqual([{ name: null, steps: ["Mix.", "Bake."] }]);
    expect(findRecipe([{ ...base, recipeInstructions: "<ol><li>Mix &amp; stir.</li><li>Bake.</li></ol>" }])?.instructions).toEqual([
      { name: null, steps: ["Mix & stir.", "Bake."] },
    ]);
    // Steps without a section around them, then a section: the loose ones keep together.
    expect(
      findRecipe([
        {
          ...base,
          recipeInstructions: [{ "@type": "HowToStep", text: "One." }, { "@type": "HowToStep", name: "Two." }, { "@type": "HowToSection", name: "Glaze", itemListElement: ["Three."] }],
        },
      ])?.instructions,
    ).toEqual([
      { name: null, steps: ["One.", "Two."] },
      { name: "Glaze", steps: ["Three."] },
    ]);
  });

  it("takes no recipe without ingredients or steps, and none where there is no recipe", () => {
    expect(findRecipe([{ "@type": "Recipe", name: "Empty" }])).toBeNull();
    expect(findRecipe([{ "@type": "Article", headline: "News" }])).toBeNull();
    expect(findRecipe([])).toBeNull();
  });

  it("caps what it reads", () => {
    const recipe = findRecipe([{ "@type": "Recipe", recipeIngredient: Array.from({ length: 500 }, (_, i) => `item ${i}`) }]);
    expect(recipe?.ingredients).toHaveLength(200);
  });
});

describe("parseDuration", () => {
  it("reads ISO 8601 durations, carrying minutes into hours", () => {
    expect(parseDuration("PT1H30M")).toEqual({ days: 0, hours: 1, minutes: 30 });
    expect(parseDuration("PT90M")).toEqual({ days: 0, hours: 1, minutes: 30 });
    expect(parseDuration("P1DT2H")).toEqual({ days: 1, hours: 2, minutes: 0 });
    expect(parseDuration("PT30S")).toEqual({ days: 0, hours: 0, minutes: 1 });
  });

  it("refuses anything else", () => {
    for (const value of ["", "P", "PT", "PT0M", "30 minutes", 30, null]) expect(parseDuration(value), String(value)).toBeNull();
  });
});

describe("helpers", () => {
  it("cleans texts of tags and entities", () => {
    expect(cleanText("  <p>Salt&nbsp;&amp; pepper</p>\n<br>to taste &#189;  ")).toBe("Salt & pepper to taste ½");
    expect(cleanText("&lt;b&gt;bold&lt;/b&gt;")).toBe("bold");
    expect(cleanText(4)).toBe("4");
    expect(cleanText({})).toBe("");
  });

  it("reads JSON-LD with raw line breaks in its strings", () => {
    expect(parseJsonLd('{"name": "a\nb"}')).toEqual({ name: "a b" });
    expect(parseJsonLd("not json")).toBeUndefined();
  });

  it("formats durations in the language asked for", () => {
    expect(formatDuration({ days: 0, hours: 1, minutes: 30 }, "en")).toMatch(/1 hr.*30 min/);
    expect(formatDuration({ days: 0, hours: 0, minutes: 45 }, "de")).toMatch(/45 Min/);
  });
});

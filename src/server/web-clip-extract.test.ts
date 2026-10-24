import { describe, expect, it } from "vitest";
import { clipHtml, extractWebPage, WEB_IMAGE_TOKEN, type RecipeLabels } from "./web-clip-extract";
import { articleHtml, recipeHtml } from "./web-clip-fixtures";

const labels: RecipeLabels = { yield: "Makes", prepTime: "Prep", cookTime: "Cook", totalTime: "Total", ingredients: "Ingredients", steps: "Steps" };

describe("extractWebPage", () => {
  const page = extractWebPage(articleHtml(), "https://news.example.com/2026/ferries?ref=home");

  it("keeps the article's text without what is around it", () => {
    expect(page.title).toBe("Night Ferries of the North Sea");
    expect(page.siteName).toBe("The Harbour Review");
    expect(page.byline).toContain("Ada Lindqvist");
    expect(page.html).toContain("The crew");
    expect(page.html).toContain("Leaves at 17:30");
    for (const clutter of ["Subscribe", "Accept all", "ADVERTISEMENT", "Most read", "First!", "All rights reserved", "hacked", "UA-123"]) {
      expect(page.html, clutter).not.toContain(clutter);
    }
    expect(page.html).not.toMatch(/<(script|style|button|nav|footer)/i);
  });

  it("points the pictures at tokens, the lazy-loaded one at its real source", () => {
    expect(page.images).toEqual([
      { token: `${WEB_IMAGE_TOKEN}1`, url: "https://images.example.com/deck.jpg" },
      { token: `${WEB_IMAGE_TOKEN}2`, url: "https://images.example.com/cabin.png" },
    ]);
    expect(page.html).toContain(`src="${WEB_IMAGE_TOKEN}1"`);
    expect(page.html).not.toContain("images.example.com");
    expect(page.html).not.toContain("data:image");
  });

  it("makes links absolute", () => {
    expect(page.html).toContain('href="https://news.example.com/archive/ferries"');
  });

  it("finds no recipe in an article", () => {
    expect(page.recipe).toBeNull();
  });

  it("reads the recipe of a recipe page, titled by it", () => {
    const recipe = extractWebPage(recipeHtml(), "https://kitchen.example.com/lentil-soup");
    expect(recipe.title).toBe("Lentil Soup with Lemon");
    expect(recipe.siteName).toBe("Kitchen Notes");
    expect(recipe.recipe?.ingredients).toHaveLength(4);
    expect(recipe.images.map((i) => i.url)).toEqual(["https://images.example.com/soup.jpg"]);
  });

  it("falls back to the page's own title and description when there's no text to pick", () => {
    const bare = extractWebPage(
      '<html><head><title>Just a title</title><meta name="description" content="A short summary."></head><body></body></html>',
      "https://www.bare.example.com/",
    );
    expect(bare.title).toBe("Just a title");
    expect(bare.siteName).toBe("bare.example.com");
    expect(bare.html).toBe("");
    expect(bare.excerpt).toBe("A short summary.");
  });
});

describe("clipHtml", () => {
  it("starts with a link back and the quote, then the text", () => {
    const page = extractWebPage(articleHtml(), "https://news.example.com/ferries");
    const html = clipHtml(page, { url: "https://news.example.com/ferries", quote: "harbour <lights>\nand more", labels, locale: "en" });
    expect(html.startsWith('<p><a href="https://news.example.com/ferries">The Harbour Review</a> · ')).toBe(true);
    expect(html).toContain("<blockquote>harbour &#60;lights&#62;<br>and more</blockquote>");
    expect(html).not.toContain("<hr>");
  });

  it("puts the recipe first: facts, ingredients to tick off, numbered steps; then a divider and the rest", () => {
    const page = extractWebPage(recipeHtml(), "https://kitchen.example.com/lentil-soup");
    const html = clipHtml(page, { url: "https://kitchen.example.com/lentil-soup", labels, locale: "en" });
    const order = ["Kitchen Notes</a>", "<strong>Makes</strong> 4 servings", "<strong>Prep</strong> 15 min", "<h2>Ingredients</h2>", '<li><input type="checkbox">1 cup red lentils</li>', "<h2>Steps</h2>", "<h3>The soup</h3>", "<ol><li>Warm the oil", "<h3>To serve</h3>", "<hr>", WEB_IMAGE_TOKEN];
    let at = -1;
    for (const part of order) {
      const next = html.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(html).toContain("Juice of 1 lemon &#38; its zest");
  });

  it("uses the description when no text was found", () => {
    const html = clipHtml(
      { title: "T", siteName: "s.example", byline: "", excerpt: "Summary.", html: "", images: [], recipe: null },
      { url: "https://s.example/", labels, locale: "en" },
    );
    expect(html).toBe('<p><a href="https://s.example/">s.example</a></p><p>Summary.</p>');
  });
});

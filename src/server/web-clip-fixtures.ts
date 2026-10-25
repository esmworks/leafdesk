/**
 * Web pages for the tests of saving web pages (web-clip-extract.test.ts, scripts/web-clip-e2e.ts):
 * an article in the usual clutter of a site, and a recipe page with its structured data.
 */

const words = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 0 ? "." : ""}`)
    .join(" ")
    .replace(/(^|\. )(\w)/g, (_, a: string, b: string) => a + b.toUpperCase());

const paragraph = (seed: string) => `<p>${words(70, seed)} and the harbour lights came on one by one along the quay.</p>`;

/** An article: navigation, a cookie banner, ads, a sidebar, comments and a footer around the text. */
export function articleHtml({ imageBase = "https://images.example.com" }: { imageBase?: string } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Night Ferries of the North Sea | The Harbour Review</title>
  <meta property="og:site_name" content="The Harbour Review">
  <meta property="og:title" content="Night Ferries of the North Sea">
  <meta name="description" content="Why the night ferries still run, and who takes them.">
  <script>window.tracker = { id: "UA-123" };</script>
  <style>.ad { color: red }</style>
</head>
<body>
  <header class="site-header"><nav class="menu"><a href="/">Home</a> <a href="/news">News</a> <a href="/sport">Sport</a> <a href="/subscribe">Subscribe</a></nav></header>
  <div class="cookie-banner">We use cookies. <button>Accept all</button></div>
  <div class="ad ad-top">ADVERTISEMENT: Buy the new SuperPhone today, only 999!</div>
  <main>
    <article>
      <h1>Night Ferries of the North Sea</h1>
      <p class="byline">By <span class="author">Ada Lindqvist</span></p>
      ${paragraph("ferry")}
      <figure><img src="${imageBase}/deck.jpg" alt="The upper deck at dusk" width="1200" height="800"><figcaption>The upper deck at dusk.</figcaption></figure>
      ${paragraph("crossing")}
      <h2>The crew</h2>
      ${paragraph("crew")}
      <img data-src="${imageBase}/cabin.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="A cabin" class="lazy">
      ${paragraph("cabin")}
      <p>Read the <a href="/archive/ferries">earlier piece on ferries</a> too.</p>
      <ul><li>Leaves at 17:30</li><li>Arrives at 09:45</li></ul>
      ${paragraph("arrival")}
    </article>
    <aside class="sidebar"><h3>Most read</h3><ul><li><a href="/a">Ten things about trains</a></li><li><a href="/b">Celebrity gossip</a></li></ul></aside>
    <section class="comments"><h3>Comments (2)</h3><div class="comment">First!</div><div class="comment">Great read.</div></section>
  </main>
  <footer class="site-footer"><p>© 2026 The Harbour Review. All rights reserved.</p><a href="/privacy">Privacy</a></footer>
  <script>document.body.innerHTML = "hacked";</script>
</body>
</html>`;
}

/** The recipe's structured data: in a @graph, with sections of steps written as HowToStep objects. */
export const RECIPE_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: "Kitchen Notes", url: "https://kitchen.example.com" },
    {
      "@type": ["Recipe"],
      name: "Lentil Soup with Lemon",
      recipeYield: ["4", "4 servings"],
      prepTime: "PT15M",
      cookTime: "PT45M",
      totalTime: "PT1H",
      recipeIngredient: ["1 cup red lentils", "1 onion, chopped", "2 tbsp olive oil", "Juice of 1 lemon &amp; its zest"],
      recipeInstructions: [
        {
          "@type": "HowToSection",
          name: "The soup",
          itemListElement: [
            { "@type": "HowToStep", text: "Warm the oil and soften the onion." },
            { "@type": "HowToStep", text: "Add the lentils and <b>1 litre</b> of water; simmer for 40 minutes." },
          ],
        },
        { "@type": "HowToSection", name: "To serve", itemListElement: [{ "@type": "HowToStep", text: "Stir in the lemon juice and zest." }] },
      ],
    },
  ],
};

/** A recipe page: a long story before the recipe, the recipe card, and the structured data. */
export function recipeHtml({ imageBase = "https://images.example.com" }: { imageBase?: string } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lentil Soup with Lemon - Kitchen Notes</title>
  <meta property="og:site_name" content="Kitchen Notes">
  <script type="application/ld+json">${JSON.stringify(RECIPE_JSON_LD)}</script>
</head>
<body>
  <nav><a href="/">Kitchen Notes</a> <a href="/recipes">Recipes</a></nav>
  <article>
    <h1>Lentil Soup with Lemon</h1>
    ${paragraph("winter")}
    <img src="${imageBase}/soup.jpg" alt="A bowl of soup">
    ${paragraph("lentil")}
    ${paragraph("lemon")}
  </article>
  <footer>Kitchen Notes, since 2009</footer>
</body>
</html>`;
}

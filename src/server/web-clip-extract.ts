import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { findRecipe, formatDuration, parseJsonLd, type Recipe } from "@/lib/recipe";

/**
 * Reading a fetched web page for saving it (server/web-clip.ts): its main text, without the
 * navigation, ads, comments and footers around it (Readability, the reader-view library), its
 * title and site, and a recipe from its structured data (lib/recipe). Then the page body to save,
 * as HTML for the editor's HTML reader (server/import/docx-convert htmlBlocks): a link back to
 * the page at the top, what the person had selected on it as a quote, the recipe, the text.
 *
 * The page is someone else's HTML: jsdom parses it without running its scripts or loading
 * anything it points at (neither is switched on), and only what the page schema knows survives
 * the HTML reader. Pictures are left for the caller to copy into the workspace: each `<img>` points
 * at a token (WEB_IMAGE_TOKEN and its number) until then, and `images` says where each one is.
 */

/** How a picture's token starts: a same-origin path, so the media check lets it through until it is placed. */
export const WEB_IMAGE_TOKEN = "/leafdesk-web-image/";

export const EXTRACT_LIMITS = {
  /** Elements Readability looks at; a page with more is read as it is, without picking its text. */
  elements: 60_000,
  /** JSON-LD scripts read, and characters of each. */
  jsonLdScripts: 20,
  jsonLdChars: 1_000_000,
  /** Characters of a quote (the person's selection). */
  quoteChars: 5_000,
};

export type ExtractedPage = {
  title: string;
  /** The site's name, else its host name. */
  siteName: string;
  byline: string;
  /** The page's own summary (its description), for a page whose text couldn't be picked out. */
  excerpt: string;
  /** The main text as HTML, its pictures pointing at tokens. Empty when no text was found. */
  html: string;
  /** The pictures of `html` in order: their tokens and where they are. */
  images: { token: string; url: string }[];
  recipe: Recipe | null;
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const meta = (document: Document, ...names: string[]) => {
  for (const name of names) {
    const value = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return "";
};

/** A web address of the page's (http or https), absolute, or null. */
function webAddress(value: string | null | undefined, base: string): string | null {
  if (!value || /^data:/i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The widest picture of a `srcset` ("a.jpg 480w, b.jpg 1080w"), or null. */
function widest(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: { url: string; size: number } | null = null;
  for (const candidate of srcset.split(/,\s+/)) {
    const [url, descriptor = "1x"] = candidate.trim().split(/\s+/);
    const size = parseFloat(descriptor) * (descriptor.endsWith("x") ? 1000 : 1);
    if (url && (!best || size > best.size)) best = { url, size: Number.isFinite(size) ? size : 0 };
  }
  return best?.url ?? null;
}

/**
 * Tidies Readability's HTML for the HTML reader: pictures to tokens (their real source picked from
 * the lazy-loading attributes and `srcset` sites use), embedded players and frames out (a saved
 * page doesn't load other sites), and links made absolute.
 */
function prepareContent(html: string, base: string): { html: string; images: ExtractedPage["images"] } {
  const { document } = new JSDOM("", { url: base, virtualConsole: new VirtualConsole() }).window;
  const root = document.createElement("div");
  root.innerHTML = html;
  for (const element of root.querySelectorAll("script, style, noscript, iframe, object, embed, video, audio, source, svg, canvas, form, button, input")) {
    element.remove();
  }
  const images: ExtractedPage["images"] = [];
  const seen = new Map<string, string>();
  for (const img of root.querySelectorAll("img")) {
    const url =
      webAddress(img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src") ?? img.getAttribute("data-original"), base) ??
      webAddress(img.getAttribute("src"), base) ??
      webAddress(widest(img.getAttribute("srcset") ?? img.getAttribute("data-srcset")), base);
    if (!url) {
      img.remove();
      continue;
    }
    let token = seen.get(url);
    if (!token) {
      token = `${WEB_IMAGE_TOKEN}${images.length + 1}`;
      seen.set(url, token);
      images.push({ token, url });
    }
    for (const name of [...img.getAttributeNames()]) if (name !== "alt" && name !== "title") img.removeAttribute(name);
    img.setAttribute("src", token);
  }
  for (const link of root.querySelectorAll("a[href]")) {
    const href = webAddress(link.getAttribute("href"), base) ?? (/^mailto:/i.test(link.getAttribute("href") ?? "") ? link.getAttribute("href") : null);
    if (href) link.setAttribute("href", href);
    else link.removeAttribute("href");
  }
  return { html: root.innerHTML, images };
}

/** Reads a fetched page (`url`: where it was fetched from, after redirects). */
export function extractWebPage(html: string, url: string): ExtractedPage {
  const { document } = new JSDOM(html, { url, virtualConsole: new VirtualConsole() }).window;
  // Before Readability, which takes the scripts out.
  const data = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .slice(0, EXTRACT_LIMITS.jsonLdScripts)
    .map((script) => parseJsonLd((script.textContent ?? "").slice(0, EXTRACT_LIMITS.jsonLdChars)));
  const recipe = findRecipe(data);
  const host = new URL(url).hostname.replace(/^www\./, "");
  const siteName = meta(document, "og:site_name", "application-name") || host;
  const headTitle = meta(document, "og:title", "twitter:title") || document.title.trim();
  const description = meta(document, "og:description", "description", "twitter:description");

  let article: ReturnType<Readability<string>["parse"]> = null;
  try {
    article = new Readability(document, { maxElemsToParse: EXTRACT_LIMITS.elements, keepClasses: false }).parse();
  } catch {
    // Too many elements, or markup Readability can't walk: the page's description stands in.
  }
  const content = article?.content ? prepareContent(article.content, url) : { html: "", images: [] };
  const title = (recipe?.name || article?.title?.trim() || headTitle || host).replace(/\s+/g, " ").slice(0, 200);
  return {
    title,
    siteName: article?.siteName?.trim() || siteName,
    byline: article?.byline?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "",
    excerpt: (article?.excerpt?.trim() || description).slice(0, 1_000),
    html: content.html,
    images: content.images,
    recipe,
  };
}

/** The words a saved recipe's parts are headed with, in the person's language. */
export type RecipeLabels = {
  yield: string;
  prepTime: string;
  cookTime: string;
  totalTime: string;
  ingredients: string;
  steps: string;
};

/** The recipe as HTML: what it makes and how long it takes, ingredients to tick off, numbered steps. */
export function recipeHtml(recipe: Recipe, labels: RecipeLabels, locale: string): string {
  const facts = [
    recipe.yield && [labels.yield, recipe.yield],
    recipe.prepTime && [labels.prepTime, formatDuration(recipe.prepTime, locale)],
    recipe.cookTime && [labels.cookTime, formatDuration(recipe.cookTime, locale)],
    recipe.totalTime && [labels.totalTime, formatDuration(recipe.totalTime, locale)],
  ].filter((fact): fact is [string, string] => Boolean(fact));
  const parts: string[] = [];
  if (facts.length) parts.push(`<p>${facts.map(([label, value]) => `<strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}`).join(" · ")}</p>`);
  if (recipe.ingredients.length) {
    parts.push(`<h2>${escapeHtml(labels.ingredients)}</h2>`);
    parts.push(`<ul>${recipe.ingredients.map((item) => `<li><input type="checkbox">${escapeHtml(item)}</li>`).join("")}</ul>`);
  }
  if (recipe.instructions.length) {
    parts.push(`<h2>${escapeHtml(labels.steps)}</h2>`);
    for (const section of recipe.instructions) {
      if (section.name) parts.push(`<h3>${escapeHtml(section.name)}</h3>`);
      parts.push(`<ol>${section.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`);
    }
  }
  return parts.join("");
}

/**
 * The body of the saved page as HTML: the link back to `url` (named by the site, with the author),
 * the person's `quote`, the recipe, then the page's text (or its description when no text was
 * found), with a divider between the recipe and the rest.
 */
export function clipHtml(
  page: ExtractedPage,
  { url, quote, labels, locale }: { url: string; quote?: string; labels: RecipeLabels; locale: string },
): string {
  const source = `<p><a href="${escapeHtml(url)}">${escapeHtml(page.siteName)}</a>${page.byline ? ` · ${escapeHtml(page.byline)}` : ""}</p>`;
  const quoted = quote?.trim()
    ? `<blockquote>${escapeHtml(quote.trim().slice(0, EXTRACT_LIMITS.quoteChars)).replace(/\r?\n+/g, "<br>")}</blockquote>`
    : "";
  const body = page.html || (page.excerpt ? `<p>${escapeHtml(page.excerpt)}</p>` : "");
  const recipe = page.recipe ? recipeHtml(page.recipe, labels, locale) : "";
  return [source, quoted, recipe, recipe && body ? "<hr>" : "", body].join("");
}

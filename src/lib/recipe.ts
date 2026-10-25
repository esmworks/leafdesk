/**
 * Reading a recipe out of a web page's structured data (schema.org `Recipe` in JSON-LD), for a
 * saved web page to start with it (server/web-clip.ts): what it makes, how long it takes, the
 * ingredients and the steps. Pure: the parsed JSON of the page's `<script type="application/ld+json">`
 * in, the recipe out; nothing here knows about HTML documents.
 *
 * Sites write this data loosely: one object, a list, a `@graph`, a page whose `mainEntity` is the
 * recipe; `@type` as a string or a list; instructions as one text, a list of texts, of steps, or
 * of sections holding steps; texts with HTML and entities in them. All of these are read.
 */

/** A length of time, from an ISO 8601 duration ("PT1H30M"). */
export type RecipeDuration = { days: number; hours: number; minutes: number };

export type RecipeSection = { name: string | null; steps: string[] };

export type Recipe = {
  name: string;
  /** What it makes ("4 servings"), as the page says it. */
  yield: string | null;
  prepTime: RecipeDuration | null;
  cookTime: RecipeDuration | null;
  totalTime: RecipeDuration | null;
  ingredients: string[];
  /** The steps, in sections when the page names them (an unnamed one otherwise). */
  instructions: RecipeSection[];
};

export const RECIPE_LIMITS = { ingredients: 200, steps: 300, textChars: 2_000, depth: 8 };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  deg: "°",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decodes the HTML entities of a text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** A text of the data as plain text: tags out, entities decoded, white space collapsed, capped. */
export function cleanText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // Entities first: some sites write their tags escaped ("&lt;p&gt;").
  const text = decodeEntities(String(value)).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, RECIPE_LIMITS.textChars);
}

/**
 * The JSON of a JSON-LD script, or undefined. Some sites put raw line breaks inside strings, which
 * JSON doesn't allow: read again with control characters as spaces.
 */
export function parseJsonLd(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return undefined;
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a node's `@type` (a string or a list) names `type`, with or without the schema.org prefix. */
function hasType(node: Record<string, unknown>, type: string): boolean {
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  return types.some((t) => typeof t === "string" && t.replace(/^(https?:\/\/schema\.org\/|schema:)/i, "") === type);
}

/** The first node of `@type` Recipe, looking through lists, `@graph` and other nodes' values. */
function findNode(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > RECIPE_LIMITS.depth) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (hasType(value, "Recipe")) return value;
  for (const [key, child] of Object.entries(value)) {
    if (key === "@context" || typeof child !== "object" || child === null) continue;
    const found = findNode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** An ISO 8601 duration ("PT1H30M", "P1DT2H", "PT90M"), or null for anything else or nothing. */
export function parseDuration(value: unknown): RecipeDuration | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((n) => (n ? Number(n) : 0));
  // In whole minutes (seconds rounded up), then carried: "PT90M" reads as 1 hour 30 minutes.
  let total = Math.ceil(days * 1440 + hours * 60 + minutes + seconds / 60);
  if (total <= 0) return null;
  const d = Math.floor(total / 1440);
  total -= d * 1440;
  return { days: d, hours: Math.floor(total / 60), minutes: total % 60 };
}

/** What a recipe makes: the most telling of the values given ("4 servings" over "4"). */
function readYield(value: unknown): string | null {
  const values = (Array.isArray(value) ? value : [value]).map(cleanText).filter(Boolean);
  if (!values.length) return null;
  return values.find((v) => /\D/.test(v)) ?? values[0];
}

/** The texts of a list that may be one string (one item per line). */
function readList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\r?\n/).map(cleanText).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(isRecord(item) ? (item.text ?? item.name) : item)).filter(Boolean);
}

/** Steps of an instruction text: its list items or paragraphs when it is HTML, else its lines. */
function splitInstructionText(text: string): string[] {
  const html = decodeEntities(text);
  const parts = /<(li|p)[\s>]/i.test(html) ? html.split(/<\/?(?:li|p|ol|ul)(?:\s[^>]*)?>/i) : text.split(/\r?\n/);
  return parts.map(cleanText).filter(Boolean);
}

/** The instructions, in sections (see Recipe), at most RECIPE_LIMITS.steps steps in all. */
function readInstructions(value: unknown): RecipeSection[] {
  const sections: RecipeSection[] = [];
  /** Sections of steps no section of the page names: consecutive ones go together. */
  const loose = new Set<RecipeSection>();
  let count = 0;
  const add = (section: RecipeSection | null, step: string) => {
    if (!step || count >= RECIPE_LIMITS.steps) return;
    count++;
    if (section) return void section.steps.push(step);
    const last = sections.at(-1);
    if (last && loose.has(last)) return void last.steps.push(step);
    const fresh = { name: null, steps: [step] };
    loose.add(fresh);
    sections.push(fresh);
  };
  const walk = (node: unknown, section: RecipeSection | null, depth: number) => {
    if (depth > RECIPE_LIMITS.depth) return;
    if (typeof node === "string") {
      for (const step of splitInstructionText(node)) add(section, step);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, section, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const items = node.itemListElement;
    if (!section && (hasType(node, "HowToSection") || (items !== undefined && !hasType(node, "HowToStep") && typeof node.name === "string"))) {
      // A named part of the recipe ("For the sauce"): its steps go under its name.
      const named: RecipeSection = { name: cleanText(node.name) || null, steps: [] };
      sections.push(named);
      walk(items, named, depth + 1);
      if (!named.steps.length) sections.splice(sections.indexOf(named), 1);
      return;
    }
    if (items !== undefined) return walk(items, section, depth + 1);
    const text = typeof node.text === "string" ? node.text : typeof node.name === "string" ? node.name : "";
    for (const step of splitInstructionText(text)) add(section, step);
  };
  walk(value, null, 0);
  return sections;
}

/**
 * The recipe in the page's JSON-LD (each script's parsed JSON), or null when there is none or it
 * has neither ingredients nor steps.
 */
export function findRecipe(values: unknown[]): Recipe | null {
  const node = findNode(values);
  if (!node) return null;
  const ingredients = readList(node.recipeIngredient ?? node.ingredients).slice(0, RECIPE_LIMITS.ingredients);
  const instructions = readInstructions(node.recipeInstructions);
  if (!ingredients.length && !instructions.length) return null;
  return {
    name: cleanText(node.name),
    yield: readYield(node.recipeYield ?? node.yield),
    prepTime: parseDuration(node.prepTime),
    cookTime: parseDuration(node.cookTime),
    totalTime: parseDuration(node.totalTime),
    ingredients,
    instructions,
  };
}

/** A duration in `locale`'s words, short ("1 hr, 30 min" in English). */
export function formatDuration(duration: RecipeDuration, locale: string): string {
  const parts = Object.fromEntries(Object.entries(duration).filter(([, n]) => n > 0));
  type DurationFormat = { format(value: Record<string, number>): string };
  const Format = (Intl as unknown as { DurationFormat?: new (locale: string, options: { style: string }) => DurationFormat }).DurationFormat;
  if (Format) {
    try {
      return new Format(locale, { style: "short" }).format(parts);
    } catch {
      // An unknown locale: the plain form below.
    }
  }
  return [duration.days && `${duration.days} d`, duration.hours && `${duration.hours} h`, duration.minutes && `${duration.minutes} min`]
    .filter(Boolean)
    .join(" ");
}

import * as z from "zod";

/**
 * PDF themes: how a workspace's PDF files (server/pdf.ts) look, written as JSON so that its owners
 * and the AI can make and change one. A theme sets the paper's colors, margins, text size, headings
 * and tables, and lays the page out as a list of elements around the page's body: a logo, texts
 * with placeholders (`{{title}}`, `{{date}}`, `{{property:Customer}}`), a fields table, boxes,
 * columns, rules, lists, a signature and blank boxes to sign or stamp in. Header and footer
 * elements repeat on every page, where `{{page}}` and `{{pages}}` count them.
 *
 * Nothing in a theme loads a URL or a file: its only image is the theme's own logo, kept with it.
 *
 * Pure and client-safe.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
export const THEME_COLOR_NAMES = ["accent", "text", "muted", "border", "fill", "white"] as const;
export type ThemeColorName = (typeof THEME_COLOR_NAMES)[number];

/** A color: `#rrggbb`, or one of the theme's own by name. */
const color = z.union([z.string().regex(HEX, "a color is #rrggbb or one of accent, text, muted, border, fill, white"), z.enum(THEME_COLOR_NAMES)]);
const align = z.enum(["left", "center", "right", "justify"]);
/** Room after an element, in points (72 to an inch). */
const after = z.number().min(0).max(200);
const words = z.string().max(2000);
const line = z.string().max(300);

const textElement = z.strictObject({
  type: z.literal("text"),
  text: words,
  size: z.number().min(5).max(48).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: color.optional(),
  align: align.optional(),
  caps: z.boolean().optional().describe("Upper case"),
  letter_spacing: z.number().min(-2).max(6).optional(),
  line_height: z.number().min(0.8).max(3).optional(),
  after: after.optional(),
});

const logoElement = z.strictObject({
  type: z.literal("logo"),
  height: z.number().min(10).max(160).optional(),
  width: z.number().min(10).max(500).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  after: after.optional(),
});

const ruleElement = z.strictObject({
  type: z.literal("rule"),
  color: color.optional(),
  thickness: z.number().min(0.25).max(12).optional(),
  after: after.optional(),
});

const spaceElement = z.strictObject({ type: z.literal("space"), height: z.number().min(0).max(400) });

const fieldsElement = z.strictObject({
  type: z.literal("fields"),
  rows: z.array(z.strictObject({ label: line, value: words })).min(1).max(30),
  /** "table": bordered rows, the labels on a fill; "plain": label and value side by side. */
  style: z.enum(["table", "plain"]).optional(),
  label_width: z.number().min(30).max(300).optional(),
  label_color: color.optional(),
  label_fill: color.optional(),
  label_caps: z.boolean().optional(),
  value_bold: z.boolean().optional(),
  size: z.number().min(5).max(24).optional(),
  /** Room above and below each row's text, in points. */
  padding: z.number().min(0).max(20).optional(),
  /** Leaves out rows whose value comes out empty (default true). */
  hide_empty: z.boolean().optional(),
  after: after.optional(),
});

const listElement = z.strictObject({
  type: z.literal("list"),
  items: z.array(words).min(1).max(40),
  numbered: z.boolean().optional(),
  size: z.number().min(5).max(24).optional(),
  color: color.optional(),
  after: after.optional(),
});

const signatureElement = z.strictObject({
  type: z.literal("signature"),
  /** Under the rule; the first in bold. */
  lines: z.array(line).min(1).max(6),
  width: z.number().min(60).max(500).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  rule_color: color.optional(),
  after: after.optional(),
});

const blanksElement = z.strictObject({
  type: z.literal("blanks"),
  /** One empty box per label, to write, sign or stamp in. */
  labels: z.array(line).min(1).max(12),
  columns: z.number().int().min(1).max(4).optional(),
  height: z.number().min(16).max(200).optional(),
  after: after.optional(),
});

const bodyElement = z.strictObject({ type: z.literal("body") });

type Leaf =
  | z.infer<typeof textElement>
  | z.infer<typeof logoElement>
  | z.infer<typeof ruleElement>
  | z.infer<typeof spaceElement>
  | z.infer<typeof fieldsElement>
  | z.infer<typeof listElement>
  | z.infer<typeof signatureElement>
  | z.infer<typeof blanksElement>
  | z.infer<typeof bodyElement>;

export type ThemeBox = {
  type: "box";
  items: ThemeElement[];
  fill?: z.infer<typeof color>;
  border?: z.infer<typeof color>;
  border_width?: number;
  padding?: number;
  align?: "left" | "center" | "right";
  after?: number;
};
export type ThemeColumns = {
  type: "columns";
  columns: { width?: number | "*" | "auto"; items: ThemeElement[] }[];
  gap?: number;
  after?: number;
};
export type ThemeElement = Leaf | ThemeBox | ThemeColumns;

const element: z.ZodType<ThemeElement> = z.lazy(() =>
  z.discriminatedUnion("type", [
    textElement,
    logoElement,
    ruleElement,
    spaceElement,
    fieldsElement,
    listElement,
    signatureElement,
    blanksElement,
    bodyElement,
    boxElement,
    columnsElement,
  ]),
);

const boxElement = z.strictObject({
  type: z.literal("box"),
  items: z.array(element).min(1).max(30),
  fill: color.optional(),
  border: color.optional(),
  border_width: z.number().min(0).max(6).optional(),
  padding: z.number().min(0).max(60).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  after: after.optional(),
});

const columnsElement = z.strictObject({
  type: z.literal("columns"),
  columns: z
    .array(z.strictObject({ width: z.union([z.number().min(20).max(560), z.literal("*"), z.literal("auto")]).optional(), items: z.array(element).max(30) }))
    .min(1)
    .max(4),
  gap: z.number().min(0).max(80).optional(),
  after: after.optional(),
});

export const pdfThemeSchema = z.strictObject({
  colors: z
    .strictObject({
      accent: z.string().regex(HEX).optional(),
      text: z.string().regex(HEX).optional(),
      muted: z.string().regex(HEX).optional(),
      border: z.string().regex(HEX).optional(),
      fill: z.string().regex(HEX).optional(),
    })
    .optional(),
  /** Points from the paper's edges. */
  margins: z
    .strictObject({ top: z.number().min(16).max(160), right: z.number().min(16).max(160), bottom: z.number().min(16).max(160), left: z.number().min(16).max(160) })
    .partial()
    .optional(),
  font_size: z.number().min(7).max(16).optional(),
  headings: z
    .strictObject({
      color: color.optional(),
      sizes: z.tuple([z.number().min(8).max(40), z.number().min(8).max(40), z.number().min(8).max(40)]).optional(),
      caps: z.boolean().optional(),
    })
    .optional(),
  tables: z
    .strictObject({
      header_fill: color.optional(),
      header_color: color.optional(),
      /** A fill for every other row; leave out for none. */
      stripes: color.optional(),
      /** "grid": every cell boxed; "rows": lines between rows only; "none". */
      lines: z.enum(["grid", "rows", "none"]).optional(),
      size: z.number().min(6).max(16).optional(),
    })
    .optional(),
  /** Whether the body starts with the page's title (the theme's own elements may print it instead, with `{{title}}`). */
  title: z.boolean().optional(),
  /** The page, top to bottom: `{ "type": "body" }` is where the page's own text goes (at the end when left out). */
  content: z.array(element).max(60).optional(),
  /** On every page, above the margin; `{{page}}` and `{{pages}}` count the pages. */
  header: z.array(element).max(20).optional(),
  /** Whether the header prints on the first page too (default true). */
  header_first_page: z.boolean().optional(),
  footer: z.array(element).max(20).optional(),
});

export type PdfTheme = z.infer<typeof pdfThemeSchema>;

/** The deepest boxes and columns may nest in each other. */
export const MAX_THEME_DEPTH = 4;

function depthOf(elements: ThemeElement[] | undefined): number {
  if (!elements?.length) return 0;
  return Math.max(
    ...elements.map((e) => (e.type === "box" ? 1 + depthOf(e.items) : e.type === "columns" ? 1 + Math.max(0, ...e.columns.map((c) => depthOf(c.items))) : 0)),
  );
}

function bodyCount(elements: ThemeElement[] | undefined): number {
  return (elements ?? []).reduce(
    (n, e) => n + (e.type === "body" ? 1 : e.type === "box" ? bodyCount(e.items) : e.type === "columns" ? e.columns.reduce((m, c) => m + bodyCount(c.items), 0) : 0),
    0,
  );
}

/** A theme checked: what's wrong with it as short lines (path: problem), for an owner or the model to fix. */
export function parsePdfTheme(value: unknown): { ok: true; theme: PdfTheme } | { ok: false; problems: string[] } {
  const parsed = pdfThemeSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "theme"}: ${issue.message}`) };
  }
  const theme = parsed.data;
  const problems: string[] = [];
  for (const part of ["content", "header", "footer"] as const) {
    if (depthOf(theme[part]) > MAX_THEME_DEPTH) problems.push(`${part}: boxes and columns nest at most ${MAX_THEME_DEPTH} deep`);
  }
  if (bodyCount(theme.content) > 1) problems.push(`content: at most one "body" element`);
  if (bodyCount(theme.header) || bodyCount(theme.footer)) problems.push(`header, footer: the "body" element goes in content`);
  return problems.length ? { ok: false, problems } : { ok: true, theme };
}

/** What placeholders stand for when a PDF is made. */
export type ThemeValues = {
  title: string;
  date: string;
  /** The reader's language, for upper case (Turkish i). */
  locale: string;
  workspace: string;
  /** A row's values as text, by property name. */
  properties: { name: string; value: string }[];
  page?: number;
  pages?: number;
};

const PLACEHOLDER = /\{\{\s*([a-z]+)(?::([^}]*))?\s*\}\}/gi;

/** `text` with its placeholders filled in; unknown ones and missing values come out empty. */
export function fillPlaceholders(text: string, values: ThemeValues): string {
  return text.replace(PLACEHOLDER, (_, key: string, arg: string | undefined) => {
    switch (key.toLowerCase()) {
      case "title":
        return values.title;
      case "date":
        return values.date;
      case "workspace":
        return values.workspace;
      case "page":
        return values.page === undefined ? "" : String(values.page);
      case "pages":
        return values.pages === undefined ? "" : String(values.pages);
      case "property": {
        const name = (arg ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
        return values.properties.find((p) => p.name.replace(/\s+/g, " ").trim().toLocaleLowerCase("en") === name)?.value ?? "";
      }
      default:
        return "";
    }
  });
}

/** Whether `text` has a placeholder in it. */
export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

export const DEFAULT_THEME_COLORS: Record<Exclude<ThemeColorName, "white">, string> = {
  accent: "#2f7d4f",
  text: "#1f2023",
  muted: "#6b6d75",
  border: "#e4e4e7",
  fill: "#f7f7f8",
};

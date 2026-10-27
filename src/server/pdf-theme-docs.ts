import * as z from "zod";
import { ENGLISH_STARTER_LABELS, starterTheme } from "@/lib/pdf-theme-starter";
import { pdfThemeSchema } from "@/lib/pdf-themes";

/**
 * How a PDF theme (lib/pdf-themes) is written, for a model: the MCP docs topic `pdf-themes` and the
 * prompt of Settings' "Change with AI" (server/pdf-theme-ai.ts) both read it.
 */

const RULES = `A PDF template (a letterhead) can have a theme: JSON that sets how the workspace's PDF files look and lays the page out around the page's own text. PDFs made from a page or row in that template (the page menu's PDF, the AI chat's create_pdf, exports) print in it.

- Units are points (72 to an inch); the paper is A4, 595 × 842 points, and the room between the margins is what elements fill.
- Colors are "#rrggbb" or one of the theme's own: "accent", "text", "muted", "border", "fill", "white".
- \`content\` is the page from top to bottom. \`{ "type": "body" }\` is where the page's own text goes (its paragraphs, tables, a linked database); without one it goes at the end. Elements before the body print once, at the top of the first page; elements after it once, after the body.
- \`header\` and \`footer\` print on every page, inside the top and bottom margins: leave margins large enough for them.
- Placeholders in any text: {{title}} (the page's title), {{date}} (today), {{workspace}} (the workspace's name), {{property:Name}} (the row's value of the property called Name, as the database shows it; empty outside a database row), {{page}} and {{pages}} (header and footer only). A fields row whose value comes out empty is left out unless hide_empty is false.
- \`title: false\` leaves the page's title out of the body, for themes that print it themselves with {{title}}.
- \`tables\` styles the body's tables and databases; \`headings\` its headings.
- Elements: text, logo (the template's own logo; the only image a theme has), rule (a line across), space, fields (label and value rows, "table" or "plain"), list (bulleted or numbered), signature (a line with text under it), blanks (empty boxes to write, sign or stamp in), box (a fill and border around elements), columns (side by side; width a number of points, "*" for the room left, or "auto"). Boxes and columns nest at most 4 deep.
- A one-page document needs its elements and body to fit: keep sizes small (body text 8.5–9.5, headings 15–18, small print 6.5–7.5) and spaces tight.`;

/** The topic's text: the rules, the schema and a whole example. */
export function pdfThemeDoc(): string {
  return [
    RULES,
    `### theme\n\n\`\`\`json\n${JSON.stringify(Object.assign(z.toJSONSchema(pdfThemeSchema, { io: "input", unrepresentable: "any" }), { $schema: undefined }))}\n\`\`\``,
    `### Example: a one-page quote\n\n\`\`\`json\n${JSON.stringify(starterTheme(ENGLISH_STARTER_LABELS))}\n\`\`\``,
  ].join("\n\n");
}

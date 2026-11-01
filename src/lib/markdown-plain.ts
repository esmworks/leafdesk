/**
 * Markdown as the plain words it shows, for a line of preview (an agent's report in the inbox):
 * headings, quotes and list markers at the start of lines, bold, italics and code marks, and links
 * down to their text. What it can't tell from text (a lone `*`, an underscore in a name) stays.
 */
export function markdownPlain(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line
        .replace(/^[ \t]*(?:#{1,6}[ \t]|>[ \t]?|[-*+][ \t]|\d{1,9}[.)][ \t]|[-*_]{3,}[ \t]*$)/, "")
        .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
        .replace(/\*\*|__|`/g, ""),
    )
    .join("\n");
}

/** A heading, a rule or a code fence's mark: a line that says nothing by itself. */
const BARE_LINE = /^[ \t]*(?:#{1,6}[ \t]|[-*_]{3,}[ \t]*$|```|~~~)/;

/**
 * The first paragraph of Markdown as one line of plain words, at most `max` characters: an
 * agent's report under its title in the inbox. Paragraphs part at blank lines; headings, rules and
 * fence marks before the first words are passed over.
 */
export function markdownSummary(markdown: string, max = 200): string {
  const paragraphs = markdown
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.split("\n").filter((line) => line.trim()))
    .filter((lines) => lines.length);
  const lines = paragraphs.find((p) => p.some((line) => !BARE_LINE.test(line))) ?? paragraphs[0] ?? [];
  const start = lines.findIndex((line) => !BARE_LINE.test(line));
  const flat = markdownPlain(lines.slice(Math.max(0, start)).join("\n")).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // Never between the two halves of a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(flat[max - 2]) ? max - 2 : max - 1;
  return `${flat.slice(0, end).trimEnd()}…`;
}

/**
 * The start of Markdown that fits in `max` characters, cut only between paragraphs, so its marks
 * stay whole (a routine's summary in Telegram); when the first paragraph alone is longer, it as
 * plain words, cut short (markdownSummary).
 */
export function markdownLead(markdown: string, max: number): string {
  const paragraphs = markdown.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n/);
  let lead = "";
  for (const paragraph of paragraphs) {
    const next = lead ? `${lead}\n\n${paragraph}` : paragraph;
    if (next.length > max) break;
    lead = next;
  }
  return lead || markdownSummary(markdown, max);
}

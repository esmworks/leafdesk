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

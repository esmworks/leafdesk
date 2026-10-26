/**
 * Rewriting the links of Markdown written in other apps (board and Trello imports) in time growing
 * with the text's length. A global regex for `[text](target)` reads the rest of the line again
 * from each `[` of a long run of them, which a crafted description makes take minutes. A `[` whose
 * text ends without a target after it starts no link, and neither does any `[` inside that text
 * (it ends at the same `]` or line break), so those aren't tried again.
 */

/** Where the text of a link starting before `from` ends: its first `]` or line break. */
function textEnd(markdown: string, from: number): number {
  const END = /[\]\n]/g;
  END.lastIndex = from;
  return END.exec(markdown)?.index ?? markdown.length;
}

/** Images (`![alt](`) as links (`[alt](`, "image" for no alt), as `.replace(/!\[([^\]\n]*)\]\(/g, …)` makes them. */
export function imagesAsLinks(markdown: string): string {
  const IMAGE = /!\[([^\]\n]*)\]\(/y;
  let out = "";
  let last = 0;
  let from = 0;
  for (let at = markdown.indexOf("!["); at !== -1; at = markdown.indexOf("![", from)) {
    IMAGE.lastIndex = at;
    const image = IMAGE.exec(markdown);
    if (image) {
      out += `${markdown.slice(last, at)}[${image[1] || "image"}](`;
      last = from = IMAGE.lastIndex;
    }
    // No image starts before this one's text ends.
    else from = textEnd(markdown, at + 2);
  }
  return out + markdown.slice(last);
}

/**
 * `markdown` with each match of `link` replaced by what `replace` returns for it, as a global
 * replace would. `link` is sticky, its first alternative a `[text](…)` link whose text is
 * `[^\]\n]*`, and its other alternatives start with `<` or `h` (addresses).
 */
export function replaceLinks(markdown: string, link: RegExp, replace: (match: RegExpExecArray) => string): string {
  const START = /[[<h]/g;
  let out = "";
  let last = 0;
  let bracketsFrom = 0;
  for (let start = START.exec(markdown); start; start = START.exec(markdown)) {
    const at = start.index;
    const bracket = markdown[at] === "[";
    if (bracket && at < bracketsFrom) continue;
    link.lastIndex = at;
    const match = link.exec(markdown);
    if (match) {
      out += markdown.slice(last, at) + replace(match);
      last = START.lastIndex = link.lastIndex;
    } else if (bracket) bracketsFrom = textEnd(markdown, at + 1);
  }
  return out + markdown.slice(last);
}

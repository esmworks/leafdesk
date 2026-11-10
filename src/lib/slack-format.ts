/**
 * The chat-app bot's messages (the HTML subset of lib/telegram-format.ts: b, i, s, code, pre, a,
 * blockquote and tg-spoiler, text escaped with escapeHtml) as Slack's mrkdwn
 * (server/slack/transport.ts). Slack escapes the same three characters (&, <, >) the same way, so
 * text stays as it is; tags become mrkdwn's marks, links `<url|label>`, quotes lines starting
 * with `>`, preformatted text a ``` block. A spoiler (what a lock screen shouldn't show) is shown
 * as preformatted text in the message, and left out of the text Slack's notifications show
 * (`hideSpoilers`). Tags it doesn't know are dropped, their text kept.
 */

type Node = { tag: string; href?: string; children: Node[] } | string;

/** The HTML parsed into a tree of the known tags; unknown tags and stray closings are dropped. */
function parse(html: string): Node[] {
  const root: { tag: string; children: Node[] } = { tag: "", children: [] };
  const stack: { tag: string; href?: string; children: Node[] }[] = [root];
  const tagPattern = /<(\/?)([a-z-]+)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi;
  let at = 0;
  for (const match of html.matchAll(tagPattern)) {
    if (match.index > at) stack.at(-1)!.children.push(html.slice(at, match.index));
    at = match.index + match[0].length;
    const [, closing, rawTag, attributes] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const open = stack.findLastIndex((n, i) => i > 0 && n.tag === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    const href = /\shref="([^"]*)"/i.exec(attributes)?.[1];
    const node = { tag, ...(href !== undefined ? { href } : {}), children: [] as Node[] };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  }
  if (at < html.length) stack.at(-1)!.children.push(html.slice(at));
  return root.children;
}

/** Text of a tree, with no marks (inside code and links' labels). */
const plain = (nodes: Node[]): string => nodes.map((n) => (typeof n === "string" ? n : plain(n.children))).join("");

/** A mark around text, outside its spaces (Slack reads `* bold*` as no mark). */
function mark(text: string, sign: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${sign}${match[2]}${sign}${match[3]}` : text;
}

type Options = { hideSpoilers: boolean };

function render(nodes: Node[], options: Options): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      const inner = () => render(node.children, options);
      switch (node.tag) {
        case "b":
        case "strong":
          return mark(inner(), "*");
        case "i":
        case "em":
          return mark(inner(), "_");
        case "s":
        case "del":
          return mark(inner(), "~");
        case "code":
          return `\`${plain(node.children).replace(/`/g, "'")}\``;
        case "pre":
          return `\`\`\`\n${plain(node.children).replace(/```/g, "'''")}\n\`\`\``;
        case "tg-spoiler":
          return options.hideSpoilers ? "…" : `\`\`\`\n${plain(node.children).replace(/```/g, "'''")}\n\`\`\``;
        case "blockquote":
          return inner()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        case "a": {
          // Attribute escaping (&quot;) isn't Slack's; &amp; stays, as Slack wants it in addresses too.
          const href = (node.href ?? "").replace(/&quot;/g, "%22").replace(/\|/g, "%7C");
          const label = plain(node.children).replace(/\|/g, "¦");
          return /^https?:\/\//i.test(href) ? `<${href}|${label}>` : label;
        }
        default:
          return inner();
      }
    })
    .join("");
}

/** The bot's HTML as Slack mrkdwn. */
export function htmlToMrkdwn(html: string, { hideSpoilers = false }: Partial<Options> = {}): string {
  return render(parse(html), { hideSpoilers });
}

/**
 * Splits mrkdwn into pieces of at most `limit` characters (Slack's section text holds 3000), at a
 * line break where one is near the end, so a mark or link is cut only in a line longer than that.
 */
export function splitMrkdwn(text: string, limit = 3000): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * A message's text as Slack sends it, as plain text for the AI: links `<url|label>` as their label
 * (or address), mentions `<@U123>` and channels `<#C123|name>` as written, `&amp;`, `&lt;` and
 * `&gt;` as the characters.
 */
export function mrkdwnToText(text: string): string {
  return text
    .replace(/<([^<>|]*)(?:\|([^<>]*))?>/g, (_, target: string, label?: string) => {
      if (target.startsWith("@")) return label ? `@${label}` : target;
      if (target.startsWith("#")) return label ? `#${label}` : target;
      if (target.startsWith("!")) return label ?? `@${target.slice(1).split("^")[0]}`;
      return label ?? target.replace(/^mailto:/, "");
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

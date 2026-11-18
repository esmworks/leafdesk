import { parse, plain, type Node } from "@/lib/slack-format";

/**
 * The chat-app bot's messages (the HTML subset of lib/telegram-format.ts) as the Markdown subset
 * Teams shows in a bot's message (server/teams/transport.ts): `**bold**`, `_italic_`, `~~strike~~`,
 * `` `code` ``, fenced code, `> quotes` and `[label](address)`. Text arrives with its entities
 * (`&amp;`) and leaves as characters, with the marks Markdown would read escaped. A spoiler (what a
 * lock screen shouldn't show) is shown as preformatted text in the message and left out of the
 * plain text a notification may preview (`hideSpoilers`). Tags it doesn't know are dropped, their
 * text kept.
 */

const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Text with the characters Markdown would read as marks escaped (and `<`, which Teams may read as a tag). */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]]/g, "\\$&")
    .replace(/</g, "&lt;")
    .replace(/^([ \t]*)([>#])/gm, "$1\\$2");
}

/** A mark around text, outside its spaces (Markdown reads `** bold**` as no mark). */
function mark(text: string, sign: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${sign}${match[2]}${sign}${match[3]}` : text;
}

const fenced = (text: string) => `\`\`\`\n${decode(text).replace(/```/g, "'''")}\n\`\`\``;

function render(nodes: Node[], hideSpoilers: boolean): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return escapeMarkdown(decode(node));
      const inner = () => render(node.children, hideSpoilers);
      switch (node.tag) {
        case "b":
        case "strong":
          return mark(inner(), "**");
        case "i":
        case "em":
          return mark(inner(), "_");
        case "s":
        case "del":
          return mark(inner(), "~~");
        case "code":
          return `\`${decode(plain(node.children)).replace(/`/g, "'")}\``;
        case "pre":
          return fenced(plain(node.children));
        case "tg-spoiler":
          return hideSpoilers ? "…" : fenced(plain(node.children));
        case "blockquote":
          return inner()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        case "a": {
          const href = decode(node.href ?? "").replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
          const label = decode(plain(node.children)).replace(/[\\[\]]/g, "\\$&");
          return /^https?:\/\//i.test(href) ? `[${label}](${href})` : escapeMarkdown(decode(plain(node.children)));
        }
        default:
          return inner();
      }
    })
    .join("");
}

/** The bot's HTML as Teams Markdown. */
export function htmlToTeamsMarkdown(html: string, { hideSpoilers = false }: { hideSpoilers?: boolean } = {}): string {
  return render(parse(html), hideSpoilers);
}

function renderPlain(nodes: Node[], hideSpoilers: boolean): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return decode(node);
      if (node.tag === "tg-spoiler" && hideSpoilers) return "…";
      return renderPlain(node.children, hideSpoilers);
    })
    .join("");
}

/** The bot's HTML as plain text, without the tags (a notification's preview hides spoilers). */
export function htmlToPlain(html: string, { hideSpoilers = false }: { hideSpoilers?: boolean } = {}): string {
  return renderPlain(parse(html), hideSpoilers);
}

/**
 * What a person wrote in Teams as plain text for the bot: mentions (`<at>Leafdesk</at>`, which a
 * channel message starts with) and other tags dropped, entities as characters.
 */
export function teamsToText(text: string): string {
  return decode(text.replace(/<at>[\s\S]*?<\/at>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]{0,200}>/g, "").replace(/&nbsp;/g, " "))
    .replace(/ /g, " ")
    .trim();
}

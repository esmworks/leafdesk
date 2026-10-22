/**
 * The AI chat's answers as Telegram messages (see server/telegram). Answers are Markdown; Telegram
 * shows a small set of HTML tags (b, i, s, code, pre, a, blockquote), so headings become bold,
 * list markers bullets, tables preformatted text, and citations ([1]) links to their pages.
 *
 * The answer is turned into blocks, each a complete piece of HTML (a paragraph line, a code block,
 * a quote), and blocks are packed into messages under Telegram's length limit, so a message never
 * ends inside a tag. What Telegram still can't parse is sent again as plain text by the caller.
 */

/** Telegram's limit is 4096 characters of text; HTML tags count before parsing, so stay under. */
export const MESSAGE_LIMIT = 4000;

/** Escapes text for Telegram's HTML: only <, > and & need it outside attributes. */
export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");

/** Where a citation's number links to, or null when its page can't be shown. */
export type CiteHref = (n: number) => string | null;

/** A link Telegram can open: http(s) only. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Inline Markdown of one line (outside code spans) as HTML: links, citations, emphasis. */
function inlineText(text: string, cite: CiteHref): string {
  // Links are taken out first, so their addresses aren't read as emphasis.
  const links: string[] = [];
  const hold = (html: string) => `\u0000${links.push(html) - 1}\u0000`;
  let out = text.replace(/\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\))?)\)/g, (_, label: string, url: string) => {
    const href = safeHref(url);
    return href ? hold(`<a href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`) : hold(escapeHtml(label));
  });
  out = out.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?![(:])/g, (whole: string, list: string) =>
    hold(
      list
        .split(",")
        .map((n) => {
          const href = cite(Number(n.trim()));
          return href ? `<a href="${escapeAttribute(href)}">[${n.trim()}]</a>` : `[${n.trim()}]`;
        })
        .join(""),
    ),
  );
  out = escapeHtml(out)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|[^_\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![_\w])/g, "$1<i>$2</i>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => links[Number(i)]);
}

/** A line's inline Markdown as HTML, with `code spans` kept as they are written. */
function inline(line: string, cite: CiteHref): string {
  return line
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => (i % 2 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : inlineText(part, cite)))
    .join("");
}

/** One Markdown line outside code and tables as HTML. */
function lineHtml(line: string, cite: CiteHref): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${inline(heading[1], cite)}</b>`;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "———";
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) return `${task[1]}${task[2] === " " ? "☐" : "☑"} ${inline(task[3], cite)}`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2], cite)}`;
  return inline(line, cite);
}

/**
 * An answer's Markdown as blocks of Telegram HTML, in order. Each block is whole: a code block,
 * a quote, a table, or a run of other lines up to a blank line.
 */
export function markdownToTelegramBlocks(markdown: string, cite: CiteHref = () => null): string[] {
  const blocks: string[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join("\n"));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      const language = fence[2] ? ` class="language-${escapeAttribute(fence[2])}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        // The row under the header (|---|:--:|) only says how columns align.
        if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i])) rows.push(lines[i].trim());
      }
      i--;
      blocks.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
      i--;
      // A callout's marker (> [!NOTE]) isn't for reading.
      const text = quoted.filter((q, n) => !(n === 0 && /^\[![\w|-]+\]\s*$/.test(q)));
      blocks.push(`<blockquote>${text.map((q) => lineHtml(q.replace(/^\[![\w|-]+\]\s*/, ""), cite)).join("\n")}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(lineHtml(line, cite));
  }
  flush();
  return blocks;
}

/** Text without its tags and entities, for a block too long for one message. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Splits plain text into pieces of at most `limit` characters, at a line break (else a space)
 * where one is near the end.
 */
export function splitText(text: string, limit = MESSAGE_LIMIT): string[] {
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
 * Blocks packed into messages of at most `limit` characters, blank lines between blocks. A block
 * longer than that on its own goes as escaped plain text, split.
 */
export function packMessages(blocks: string[], limit = MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (block.length > limit) {
      if (current) messages.push(current);
      current = "";
      for (const piece of splitText(htmlToText(block), limit - 200)) messages.push(escapeHtml(piece));
      continue;
    }
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > limit) {
      messages.push(current);
      current = block;
    } else current = next;
  }
  if (current) messages.push(current);
  return messages;
}

/** A short one-line preview of text: whitespace folded, cut to `max` characters with an ellipsis. */
export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

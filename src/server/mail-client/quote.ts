import type { Config } from "dompurify";
import type { ImapFlow } from "imapflow";
import { RowMailError } from "@/server/row-mail/settings";
import { filesOf, type Attachment, type StoredMessage, type Written } from "./compose";
import { htmlText } from "./html";
import { decodeText, messageParts, readParts } from "./structure";

/**
 * The earlier mail an answer or a forward carries under what was written: the original's own HTML
 * (its tables, colors and images kept, its stylesheet and anything that runs left out), under a
 * header line, with the images it carries going along as parts of the message; its text part
 * quoted with "> ". It is marked with a class, so the Mail tab folds an answer's quote when it is
 * read (html.ts) and opens a draft without it (outgoing.ts `editableBody`), and a draft saved again
 * takes it from the draft before rather than from the original.
 */

export const QUOTE_CLASS = "leafdesk_quote";
export const FORWARD_CLASS = "leafdesk_forward";
const MARKED = `.${QUOTE_CLASS}, .${FORWARD_CLASS}`;

export type Quote = { html: string; text: string; files: Attachment[]; cids: Set<string> };

/** Bytes of an original's text or HTML read to quote it; images it carries, at most in all. */
const MAX_QUOTED_BYTES = 2 * 1024 * 1024;
const MAX_QUOTED_IMAGES = 5 * 1024 * 1024;
const travelling = (bytes: number) => Math.ceil(bytes * 1.4) + 1024;

const CONFIG: Config = {
  FORBID_TAGS: ["style", "link", "meta", "base", "title", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset", "object", "embed", "applet", "audio", "video", "source", "track", "portal", "math", "svg"],
  // Its classes and ids would answer to what is written above it, and its stylesheet is left out.
  FORBID_ATTR: ["class", "id", "srcset", "ping", "action", "formaction", "background", "poster", "lowsrc", "dynsrc"],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function dom() {
  const [{ JSDOM, VirtualConsole }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("", { virtualConsole: new VirtualConsole() });
  return { window, purify: createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]) };
}

/** An original's HTML as it is quoted: cleaned (CONFIG), its body only. */
async function cleanQuoted(raw: string) {
  const { purify } = await dom();
  return purify.sanitize(raw, CONFIG) as string;
}

/** A message's text, HTML and the images its HTML shows, read from the mail server. */
async function contentOf(client: ImapFlow, message: StoredMessage) {
  const lock = await client.getMailboxLock(message.path, { readOnly: true });
  try {
    const fetched = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!fetched || !fetched.bodyStructure) throw new RowMailError("gone");
    const parts = messageParts(fetched.bodyStructure);
    const wanted = [parts.text, parts.html].filter((p) => !!p).map((p) => ({ part: p!.part, limit: travelling(MAX_QUOTED_BYTES) }));
    const raw = await readParts(client, message.uid, wanted);
    const textOf = (ref: typeof parts.text) => {
      const bytes = ref && raw.get(ref.part);
      return bytes ? decodeText(bytes, ref.encoding, ref.charset) : null;
    };
    return { html: textOf(parts.html), text: textOf(parts.text), attachments: parts.attachments };
  } finally {
    lock.release();
  }
}

/**
 * The images `html` shows by Content-ID, read from the message, MAX_QUOTED_IMAGES at most; the
 * ones left out are taken out of the HTML, not left as broken pictures.
 */
async function picturesOf(client: ImapFlow, message: StoredMessage, html: string, attachments: Awaited<ReturnType<typeof contentOf>>["attachments"]) {
  let room = MAX_QUOTED_IMAGES;
  const wanted = attachments.filter((a) => a.inline && a.contentId && html.includes(`cid:${a.contentId}`) && (room -= a.size / 1.4) >= 0);
  const files = wanted.length ? await filesOf(client, message, wanted.map((a) => a.part)) : [];
  const cids = new Set(files.flatMap((f) => (f.cid ? [f.cid] : [])));
  const kept = html.replace(/<img\b[^>]*\bsrc\s*=\s*["']?cid:([^"'\s>]+)[^>]*>/gi, (img, cid: string) => (cids.has(cid.replace(/^<|>$/g, "")) ? img : ""));
  return { html: kept, files, cids };
}

/** The quote's HTML and text part: the header, then the original, an answer's in a cited blockquote. */
function wrap(header: string[], html: string, text: string, forward: boolean) {
  const head = `<p style="margin:16px 0 8px">${header.map(escape).join("<br>")}</p>`;
  return {
    html: forward
      ? `<div class="${FORWARD_CLASS}">${head}<div>${html}</div></div>`
      : `<div class="${QUOTE_CLASS}">${head}<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote></div>`,
    text: `${header.join("\n")}\n${forward ? text.replace(/\r\n/g, "\n").trimEnd() : quoteLines(text)}`,
  };
}

/** "> " before each line of an answer's quoted text. */
const quoteLines = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

/**
 * The quote of `source`, the message answered or forwarded, under `header` (the lines the composer
 * wrote: who wrote it when, or a forward's header).
 */
export async function freshQuote(client: ImapFlow, source: StoredMessage, header: string[], forward: boolean): Promise<Quote> {
  const content = await contentOf(client, source);
  const text = content.text ?? (content.html ? await htmlText(content.html) : "");
  const pictures = content.html
    ? await picturesOf(client, source, await cleanQuoted(content.html), content.attachments)
    : { html: `<div style="white-space:pre-wrap">${escape(text)}</div>`, files: [], cids: new Set<string>() };
  return { ...wrap(header, pictures.html, text, forward), files: pictures.files, cids: pictures.cids };
}

/** The quote a draft carries (as freshQuote wrote it), cleaned again: null when it has none. */
export async function keptQuote(client: ImapFlow, draft: StoredMessage): Promise<Quote | null> {
  const content = await contentOf(client, draft);
  if (!content.html) return null;
  const { window } = await dom();
  const document = new window.DOMParser().parseFromString(content.html, "text/html");
  const marked = document.querySelector(MARKED);
  if (!marked) return null;
  const forward = marked.classList.contains(FORWARD_CLASS);
  const head = marked.firstElementChild?.tagName === "P" ? marked.firstElementChild : null;
  const header = (head?.innerHTML.split(/<br\s*\/?>/i) ?? []).map((line) => {
    const holder = document.createElement("div");
    holder.innerHTML = line;
    return holder.textContent ?? "";
  });
  head?.remove();
  const inner = forward ? (marked.firstElementChild?.innerHTML ?? marked.innerHTML) : (marked.querySelector("blockquote")?.innerHTML ?? marked.innerHTML);
  const pictures = await picturesOf(client, draft, await cleanQuoted(inner), content.attachments);
  const wrapped = wrap(header, pictures.html, await htmlText(pictures.html), forward);
  // The text part keeps the quote as it was first written from the original's own text part: read
  // back from the HTML, a table's cells would run together.
  const plain = content.text?.replace(/\r\n/g, "\n") ?? "";
  const at = header.length ? plain.indexOf(`\n${header.join("\n")}\n`) : -1;
  return { ...wrapped, text: at >= 0 ? plain.slice(at + 1).trimEnd() : wrapped.text, files: pictures.files, cids: pictures.cids };
}

/** What was written with the quote under it, in the HTML (inside its font) and in the text part. */
export function withQuote(w: Written, quote: Quote | null): Written {
  if (!quote) return w;
  const html = w.html ? w.html.replace(/<\/div><\/body><\/html>$/, () => `${quote.html}</div></body></html>`) : w.html;
  return { ...w, html, text: `${w.text}${w.text ? "\n\n" : ""}${quote.text}` };
}

/** A draft's HTML without its quote, and the quote apart (for the composer to show), or null. */
export async function splitQuote(html: string): Promise<{ html: string; quote: string | null }> {
  if (!html.includes(QUOTE_CLASS) && !html.includes(FORWARD_CLASS)) return { html, quote: null };
  const { window } = await dom();
  const document = new window.DOMParser().parseFromString(html, "text/html");
  const marked = document.querySelector(MARKED);
  if (!marked) return { html, quote: null };
  const quote = marked.outerHTML;
  marked.remove();
  return { html: document.documentElement.outerHTML, quote };
}

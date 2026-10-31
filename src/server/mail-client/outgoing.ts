import type { Config } from "dompurify";
import { pastedHtml, wrapPasted } from "@/lib/pasted-signature";
import { PASTED_SIGNATURE_CONFIG } from "@/lib/pasted-signature-config";

/**
 * What the Mail tab's editor writes (components/mail/mail-editor.tsx), made fit to send: only the
 * formatting it offers survives (paragraphs, bold, italic, underline, strike, links, lists and
 * quotes, and the sender's signature around some of them), links only to the web or an address,
 * and no styles but the few written here, inline, as mail programs want them. The message's
 * plain-text part is written from the same HTML. A signature pasted from another mail program
 * (lib/pasted-signature.ts) is the exception: it goes out as it came, cleaned on its own terms.
 */

const CONFIG: Config = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "div"],
  ALLOWED_ATTR: ["href", "data-signature", "data-pasted"],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  ALLOW_DATA_ATTR: false,
};
/** A signature is kept as the formatting inside one: never a signature of its own. */
const SIGNATURE_CONFIG: Config = { ...CONFIG, ALLOWED_TAGS: CONFIG.ALLOWED_TAGS!.filter((tag) => tag !== "div"), ALLOWED_ATTR: ["href"] };

/** Paragraphs follow each other as lines, as the editor shows them. */
const STYLES: Record<string, string> = {
  P: "margin:0",
  UL: "margin:0;padding-inline-start:1.5em",
  OL: "margin:0;padding-inline-start:1.5em",
  BLOCKQUOTE: "margin:0 0 0 0.8ex;border-inline-start:2px solid #d0d7de;padding-inline-start:1ex;color:#57606a",
  DIV: "margin:0",
};
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328";

export type OutgoingBody = { html: string; text: string };

async function purifier() {
  const [{ JSDOM, VirtualConsole }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("", { virtualConsole: new VirtualConsole() });
  return { window, purify: createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]) };
}
type Purifier = Awaited<ReturnType<typeof purifier>>;

async function clean(raw: string, config: Config) {
  const { window, purify } = await purifier();
  return { window, body: purify.sanitize(raw, { ...config, RETURN_DOM: true }) as unknown as HTMLElement };
}

/** A pasted signature's HTML as it is kept and sent; an image whose address was taken out goes with it. */
function cleanPasted({ purify }: Purifier, raw: string) {
  const body = purify.sanitize(raw, { ...PASTED_SIGNATURE_CONFIG, RETURN_DOM: true }) as unknown as HTMLElement;
  for (const img of Array.from(body.querySelectorAll("img:not([src])"))) img.remove();
  return body;
}

/** Whether a signature still shows anything: words, or a pasted one's images. */
const shows = (el: Element) => !!el.textContent?.trim() || !!el.querySelector("img");

/** The text part: no spaces at lines' ends, but for the one of a signature's "-- " line. */
const textOf = (body: Element) =>
  blocks(body)
    .join("\n")
    .split("\n")
    .map((line) => (line === "-- " ? line : line.trimEnd()))
    .join("\n")
    .replace(/\n+$/, "");

export async function outgoingBody(raw: string): Promise<OutgoingBody> {
  const dom = await purifier();
  const { window, purify } = dom;
  // Pasted signatures are taken out before the message is cleaned and put back after its styles
  // are set, each in the place it had; any other `data-pasted` is only a div.
  const doc = new window.DOMParser().parseFromString(raw, "text/html");
  const pasted: HTMLElement[] = [];
  for (const el of Array.from(doc.querySelectorAll("[data-pasted]"))) {
    if (doc.contains(el) && el.matches("div[data-signature] > div[data-pasted]")) {
      pasted.push(cleanPasted(dom, el.innerHTML));
      el.innerHTML = "";
    } else el.removeAttribute("data-pasted");
  }
  const body = purify.sanitize(doc.body.innerHTML, { ...CONFIG, RETURN_DOM: true }) as unknown as HTMLElement;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const style = STYLES[el.tagName];
    if (style) el.setAttribute("style", style);
    // An empty paragraph is an empty line: it needs something in it to keep its height.
    if (el.tagName === "P" && !el.childNodes.length) el.appendChild(window.document.createElement("br"));
  }
  Array.from(body.querySelectorAll("div[data-pasted]")).forEach((el, i) => el.replaceChildren(...(pasted[i]?.childNodes ?? [])));
  // A signature whose words were all taken out goes, with no separator left behind.
  for (const signature of Array.from(body.querySelectorAll("div[data-signature]"))) if (!shows(signature)) signature.remove();
  const text = textOf(body);
  for (const el of Array.from(body.querySelectorAll("[data-signature], [data-pasted]"))) el.removeAttribute(el.hasAttribute("data-signature") ? "data-signature" : "data-pasted");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><div style="${FONT}">${body.innerHTML}</div></body></html>`;
  return { html, text };
}

/**
 * A signature as its owner wrote it in the settings' editor: the same formatting as a message,
 * without empty lines at its end, as HTML for the editor to start from and as plain text for row
 * emails; or as they pasted it, kept as it came. Null when nothing is left of it.
 */
export async function cleanSignature(raw: string): Promise<OutgoingBody | null> {
  const paste = pastedHtml(raw);
  if (paste !== null) {
    const body = cleanPasted(await purifier(), paste);
    return shows(body) ? { html: wrapPasted(body.innerHTML.trim()), text: pastedText(body) } : null;
  }
  const { body } = await clean(raw, SIGNATURE_CONFIG);
  while (body.lastElementChild && !body.lastElementChild.textContent?.trim()) body.lastElementChild.remove();
  const text = textOf(body);
  if (!text.trim()) return null;
  return { html: body.innerHTML, text };
}

/** A paragraph's text: line breaks kept, a link's address after its words when they differ. */
function inline(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  if (el.tagName === "BR") return "\n";
  const inner = Array.from(el.childNodes).map(inline).join("");
  if (el.tagName === "A") {
    const href = el.getAttribute("href");
    return href && href.replace(/^mailto:/i, "") !== inner.trim() ? `${inner} <${href}>` : inner;
  }
  return inner;
}

/**
 * The lines of what an element holds: a list's items marked, a quote's lines after `> `, a
 * signature under the usual "-- " line.
 */
function blocks(el: Element): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run) out.push(run);
    run = "";
  };
  for (const child of Array.from(el.childNodes)) {
    const tag = child.nodeType === 1 ? (child as Element).tagName : "";
    if (tag === "P") {
      flush();
      // The <br> an empty paragraph was given above is the line itself.
      const text = inline(child);
      out.push(text === "\n" ? "" : text);
    } else if (tag === "UL" || tag === "OL") {
      flush();
      let n = 1;
      for (const item of Array.from((child as Element).children)) {
        const mark = tag === "OL" ? `${n++}. ` : "- ";
        out.push(mark + blocks(item).join("\n").replace(/\n/g, `\n${" ".repeat(mark.length)}`));
      }
    } else if (tag === "BLOCKQUOTE") {
      flush();
      out.push(
        blocks(child as Element)
          .join("\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    } else if (tag === "DIV") {
      flush();
      const div = child as Element;
      out.push(...(div.hasAttribute("data-signature") ? ["-- "] : []), ...(div.hasAttribute("data-pasted") ? [pastedText(div)] : blocks(div)));
    } else run += inline(child);
  }
  flush();
  return out;
}

/** What lays out a pasted signature's lines; cells of a row stand side by side. */
const PASTED_BLOCKS = new Set(["P", "DIV", "TABLE", "TR", "UL", "OL", "LI", "BLOCKQUOTE", "CENTER", "H1", "H2", "H3", "H4", "H5", "H6", "HR"]);
/** A link's address and its words alike, as people write either: no scheme, case or ending slash. */
const bare = (s: string) => s.replace(/^(mailto:|https?:\/\/)/i, "").replace(/\/$/, "").toLowerCase();

/**
 * A pasted signature's lines: each block and table row its own, without empty ones, and a web or
 * mail link's address after its words when they differ. Images, and links around nothing but
 * them, leave no text; nor does a "--" line it starts with, which the text part writes itself.
 */
function pastedText(el: Element) {
  const lines: string[] = [];
  let line = "";
  const end = () => {
    const words = line.replace(/\s+/g, " ").trim();
    if (words) lines.push(words);
    line = "";
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) line += node.textContent ?? "";
    if (node.nodeType !== 1) return;
    const e = node as Element;
    if (e.tagName === "BR") return end();
    const block = PASTED_BLOCKS.has(e.tagName);
    if (block) end();
    else if (e.tagName === "TD" || e.tagName === "TH") line += " ";
    const from = line.length;
    e.childNodes.forEach(walk);
    const href = e.tagName === "A" ? e.getAttribute("href") : null;
    const words = line.slice(from).replace(/\s+/g, " ").trim();
    if (href && /^(https?|mailto):/i.test(href) && words && bare(href) !== bare(words)) line += ` <${href}>`;
    if (block) end();
  };
  el.childNodes.forEach(walk);
  end();
  if (lines[0] === "--") lines.shift();
  return lines.join("\n");
}

import type { Config } from "dompurify";

/**
 * What the Mail tab's editor writes (components/mail/mail-editor.tsx), made fit to send: only the
 * formatting it offers survives (paragraphs, bold, italic, underline, strike, links, lists and
 * quotes, and the sender's signature around some of them), links only to the web or an address,
 * and no styles but the few written here, inline, as mail programs want them. The message's
 * plain-text part is written from the same HTML.
 */

const CONFIG: Config = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "div"],
  ALLOWED_ATTR: ["href", "data-signature"],
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

async function clean(raw: string, config: Config) {
  const [{ JSDOM, VirtualConsole }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("", { virtualConsole: new VirtualConsole() });
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  return { window, body: purify.sanitize(raw, { ...config, RETURN_DOM: true }) as unknown as HTMLElement };
}

/** The text part: no spaces at lines' ends, but for the one of a signature's "-- " line. */
const textOf = (body: Element) =>
  blocks(body)
    .join("\n")
    .split("\n")
    .map((line) => (line === "-- " ? line : line.trimEnd()))
    .join("\n")
    .replace(/\n+$/, "");

export async function outgoingBody(raw: string): Promise<OutgoingBody> {
  const { window, body } = await clean(raw, CONFIG);
  // A signature whose words were all taken out goes, with no separator left behind.
  for (const signature of Array.from(body.querySelectorAll("div[data-signature]"))) if (!signature.textContent?.trim()) signature.remove();
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const style = STYLES[el.tagName];
    if (style) el.setAttribute("style", style);
    // An empty paragraph is an empty line: it needs something in it to keep its height.
    if (el.tagName === "P" && !el.childNodes.length) el.appendChild(window.document.createElement("br"));
  }
  const text = textOf(body);
  for (const signature of Array.from(body.querySelectorAll("div[data-signature]"))) signature.removeAttribute("data-signature");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><div style="${FONT}">${body.innerHTML}</div></body></html>`;
  return { html, text };
}

/**
 * A signature as its owner wrote it in the settings' editor: the same formatting as a message,
 * without empty lines at its end, as HTML for the editor to start from and as plain text for row
 * emails. Null when nothing is left of it.
 */
export async function cleanSignature(raw: string): Promise<OutgoingBody | null> {
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
      out.push(...((child as Element).hasAttribute("data-signature") ? ["-- "] : []), ...blocks(child as Element));
    } else run += inline(child);
  }
  flush();
  return out;
}

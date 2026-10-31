import type { Config } from "dompurify";

/**
 * A message's HTML made safe to show: no scripts, handlers, forms, frames or other documents, and
 * links that open in a new tab. Images from other sites are taken out unless the reader asked for
 * them (they tell the sender the mail was opened, and from where); the frame the HTML is shown in
 * (components/mail/mail-frame.tsx) blocks what slips through with its own content policy.
 * Images the message carries (`cid:`) come in as data addresses.
 */

const CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  ADD_TAGS: ["style"],
  FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "base", "link", "meta", "iframe", "frame", "frameset", "object", "embed", "applet", "audio", "video", "source", "track", "portal", "math", "svg"],
  FORBID_ATTR: ["srcset", "ping", "action", "formaction", "background", "poster", "lowsrc", "dynsrc"],
  ALLOW_DATA_ATTR: false,
  // DOMPurify tests every attribute value it has no list for against this, not only addresses: like
  // its own default, it lets through values that name no scheme (a width, `center`, `ltr`, `#fff`, a
  // relative link), or a message's sizes, alignment and table spans are dropped.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|data:image\/(?:png|gif|jpe?g|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;

export type CleanHtml = { html: string; blockedImages: number };

export async function cleanMailHtml(raw: string, options: { images: boolean; inline: Map<string, string> }): Promise<CleanHtml> {
  const [{ JSDOM, VirtualConsole }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("", { virtualConsole: new VirtualConsole() });
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  let blocked = 0;

  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (/^cid:/i.test(src)) {
        const data = options.inline.get(src.slice(4).replace(/^<|>$/g, "").trim());
        if (data) el.setAttribute("src", data);
        else {
          // A part the message doesn't carry: hidden like a left-out image, not an empty box of its size.
          el.removeAttribute("src");
          el.setAttribute("data-blocked", "");
        }
      } else if (REMOTE.test(src) && !options.images) {
        el.removeAttribute("src");
        el.setAttribute("data-blocked", "");
        blocked++;
      }
    }
    const style = el.getAttribute?.("style");
    if (style && !options.images && CSS_REMOTE_URL.test(style)) {
      CSS_REMOTE_URL.lastIndex = 0;
      el.setAttribute("style", style.replace(CSS_REMOTE_URL, "none"));
      blocked++;
    }
    CSS_REMOTE_URL.lastIndex = 0;
  });
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "style" || options.images) return;
    const css = node.textContent ?? "";
    const stripped = css.replace(CSS_REMOTE_URL, "none").replace(/@import[^;]*;?/gi, "");
    if (stripped !== css) {
      blocked++;
      node.textContent = stripped;
    }
  });

  const html = purify.sanitize(raw, CONFIG) as string;
  if (!html.includes("data-blocked")) return { html, blockedImages: blocked };
  const document = new window.DOMParser().parseFromString(html, "text/html");
  for (const img of document.querySelectorAll("img[data-blocked]")) hideHolder(img);
  return { html: document.documentElement.outerHTML, blockedImages: blocked };
}

/** Table parts keep their place even when empty: hiding one shifts the cells beside it. */
const TABLE_PARTS = new Set(["TD", "TH", "TR", "THEAD", "TBODY", "TFOOT", "TABLE", "CAPTION", "COLGROUP", "COL"]);

/**
 * Hides what a left-out image leaves empty: signatures set icons and banners in boxes of a fixed
 * size, links and paragraphs of their own, which would stand blank where the images were. The
 * frame hides whatever carries `data-blocked`; the images come back with their boxes once asked for.
 */
function hideHolder(img: Element) {
  let holder = img;
  for (let up = img.parentElement; up && up.tagName !== "BODY" && !TABLE_PARTS.has(up.tagName); up = up.parentElement) {
    if ((up.textContent ?? "").trim() || up.querySelector("img:not([data-blocked]), video, iframe, hr, input, table")) break;
    holder = up;
  }
  holder.setAttribute("data-blocked", "");
}

/** A message's text from its HTML, for mail that comes without a plain-text part. */
export async function htmlText(raw: string): Promise<string> {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const { document } = new JSDOM(raw, { virtualConsole: new VirtualConsole() }).window;
  for (const el of document.querySelectorAll("script, style, head")) el.remove();
  for (const el of document.querySelectorAll("br")) el.replaceWith("\n");
  for (const el of document.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote")) el.append("\n");
  return (document.body?.textContent ?? "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

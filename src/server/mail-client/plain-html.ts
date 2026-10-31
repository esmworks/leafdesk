/**
 * Whether a cleaned message's HTML is plain: text, links, quotes and tables written in the mail
 * program's default colors, with nothing designed for a white page. The frame
 * (components/mail/mail-frame.tsx) draws a plain message in the page's own colors, so on the dark
 * theme it reads as part of the page; anything else keeps its white page.
 *
 * A text color that is a grey (black, #1f2328, Gmail's rgb(34,34,34)) or a white or near-white
 * background counts as a default: the frame overrides both. Any other color, a background image or
 * a picture makes it designed. Link colors don't count: the frame gives links the page's own.
 * When unsure, designed: white is always readable, a dark page under colors meant for white isn't.
 */
export function isPlainHtml(document: Document): boolean {
  if (document.querySelector("img, picture, svg, video, canvas")) return false;
  for (const style of document.querySelectorAll("style")) {
    if (!plainCss(style.textContent ?? "")) return false;
  }
  for (const el of document.querySelectorAll("*")) {
    const link = !!el.closest("a");
    const style = el.getAttribute("style");
    if (style && !plainDeclarations(style, link)) return false;
    const bg = el.getAttribute("bgcolor");
    if (bg !== null && !defaultBackground(bg)) return false;
    const color = el.getAttribute("color");
    if (color !== null && !link && !defaultText(color)) return false;
  }
  return true;
}

/** A link's own rules (`a:link`, Outlook's `.MsoHyperlink`): their colors don't count. */
const LINK_SELECTOR = /(?:^|[\s>+~])a(?:\.[\w-]+)*(?::[\w-]+)*$|\.MsoHyperlink/i;

function plainCss(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors, body] of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const link = selectors.split(",").every((s) => LINK_SELECTOR.test(s.trim()));
    if (!plainDeclarations(body, link)) return false;
  }
  return true;
}

function plainDeclarations(declarations: string, link: boolean): boolean {
  for (const declaration of declarations.split(";")) {
    const at = declaration.indexOf(":");
    if (at < 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).trim();
    if (property === "color" || property === "-webkit-text-fill-color") {
      if (!link && !defaultText(value)) return false;
    } else if (property === "background" || property === "background-color") {
      if (!defaultBackground(value)) return false;
    } else if (property === "background-image") {
      if (!/^none$/i.test(value)) return false;
    }
  }
  return true;
}

/** Values that leave a color as it was, or to the page. */
const KEEPS = new Set(["inherit", "initial", "unset", "revert", "currentcolor", "transparent", "none", "windowtext", "window", "canvas", "canvastext", "auto"]);

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  silver: [192, 192, 192],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  snow: [255, 250, 250],
  ghostwhite: [248, 248, 255],
};

/** A color's red, green and blue, or null when it isn't one of the forms read here. */
function rgb(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
  if (hex && (hex.length === 6 || hex.length === 8)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const fn = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

const grey = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b) <= 30;

/** A text color the frame may replace with the page's: a grey of any shade. */
function defaultText(value: string): boolean {
  if (/!important/i.test(value)) return false;
  if (KEEPS.has(value.trim().toLowerCase())) return true;
  const color = rgb(value);
  return !!color && grey(color);
}

/** A background the frame may take away: none, or white and greys close to it. */
function defaultBackground(value: string): boolean {
  if (/!important|url\(/i.test(value)) return false;
  if (KEEPS.has(value.trim().toLowerCase())) return true;
  const color = rgb(value);
  return !!color && grey(color) && Math.min(...color) >= 240;
}

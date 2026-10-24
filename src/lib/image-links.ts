import { createBlockSpec, createImageBlockConfig, imageParse, imageRender, imageToExternalHTML } from "@blocknote/core";
import { cropCss, cropStyles, parseImageCrop } from "./image-crop";
import { linkedPageRef } from "./mentions";
import { markdownLinkDestination, markdownLinkText } from "./web-blocks";

/**
 * Images that link somewhere: BlockNote's image block with one more prop, `link`, a web address or
 * a page of the app (its path, `/w/<workspace>/p/<page>`). Nothing else is kept: a link a person
 * pasted that is neither reads as no link. In the editor a click still selects the image (to resize
 * or caption it); a button over it opens the link (components/page/editor-files.tsx). Published
 * pages and print wrap the image in the link (server/published-body.ts).
 *
 * In HTML the image sits inside the link (`toExternalHTML`, and `parse` reads it back from pasted
 * HTML). In Markdown it is `[![alt](src)](href)`, or with a caption the HTML BlockNote writes for
 * one with the `<a>` around the `<img>`; lib/content-markdown writes and reads both forms itself
 * (linkedImageMarkdown, parseLinkedImageLine), so Markdown writes (MCP, the source view) keep it.
 *
 * Images may also be cropped (`crop`, lib/image-crop): the block shows a part of its file. The
 * editor draws it with the same styles as the block's HTML (published pages, print, export).
 *
 * Pure apart from BlockNote's DOM helpers: the spec is shared by the editor (embed-blocks.tsx) and
 * the server (server/blocknote.ts).
 */

export const IMAGE_BLOCK = "image";
export const MAX_IMAGE_LINK = 2000;

/** What an image links to: a web address, or a page of the app by its path. */
export type ImageLink = { kind: "url"; href: string } | { kind: "page"; href: string; pageId: string };

/**
 * The link an image may hold, from what was typed or found: http(s) without credentials, or a
 * link to one of the app's pages (an absolute one when `appUrl` is its origin), kept as its path.
 */
export function parseImageLink(value: unknown, appUrl?: string): ImageLink | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_IMAGE_LINK) return null;
  const page = linkedPageRef(text, appUrl);
  if (page) {
    const origin = appUrl?.replace(/\/+$/, "");
    const path = origin && text.toLowerCase().startsWith(`${origin.toLowerCase()}/`) ? text.slice(origin.length) : text;
    if (path.startsWith("/")) return { kind: "page", href: path, pageId: page.pageId };
  }
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return { kind: "url", href: url.href };
  } catch {
    return null;
  }
}

const base = createImageBlockConfig({});

export const imageBlockConfig = {
  ...base,
  propSchema: { ...base.propSchema, link: { default: "" as const }, crop: { default: "" as const } },
} as const;

/** The link `element` (an image, or a figure holding one) sits in, as an image keeps it. */
function linkOf(element: HTMLElement): string {
  const anchor = element.tagName === "FIGURE" ? element.querySelector("a") : element.closest("a");
  return parseImageLink(anchor?.getAttribute("href"))?.href ?? "";
}

/** The image block with its link: BlockNote's own, which also reads and writes the link in HTML. */
export const linkedImageSpec = createBlockSpec(imageBlockConfig, {
  meta: { fileBlockAccept: ["image/*"] },
  parse: (element) => {
    const parsed = imageParse()(element);
    if (!parsed) return undefined;
    const link = linkOf(element);
    return link ? { ...parsed, link } : parsed;
  },
  render: (block, editor) => {
    const rendered = imageRender()(block as never, editor as never);
    if (block.props.link) rendered.dom.setAttribute("data-image-link", "");
    const crop = block.props.url && block.props.showPreview ? parseImageCrop(block.props.crop) : null;
    const box = crop && rendered.dom.querySelector<HTMLElement>(".bn-visual-media-wrapper");
    const image = box && box.querySelector<HTMLElement>("img");
    if (crop && box && image) {
      const styles = cropStyles(crop);
      box.setAttribute("data-image-crop", "");
      Object.assign(box.style, styles.box, { width: "100%" });
      Object.assign(image.style, styles.image);
      // The image no longer sizes the block: without a width of its own it takes the line's.
      if (!block.props.previewWidth) rendered.dom.style.width = "100%";
    }
    return rendered;
  },
  toExternalHTML: (block, editor) => {
    const out = imageToExternalHTML()(block as never, editor as never);
    const crop = block.props.url && block.props.showPreview ? parseImageCrop(block.props.crop) : null;
    const img = crop ? (out.dom.tagName === "IMG" ? out.dom : out.dom.querySelector("img")) : null;
    if (crop && img) {
      // The part of the image in a box of its shape, as wide as the image was shown.
      const styles = cropStyles(crop);
      const box = document.createElement("div");
      box.setAttribute("data-image-crop", "");
      const width = block.props.previewWidth ? `${Number(block.props.previewWidth)}px` : "100%";
      box.setAttribute("style", `${cropCss(styles.box)};width:${width};max-width:100%`);
      img.setAttribute("style", cropCss(styles.image));
      img.replaceWith(box);
      box.appendChild(img);
      if (out.dom === img) out.dom = box;
    }
    // A web address, or a path of this site: the page's own, or where a published page shows it.
    const link = typeof block.props.link === "string" && /^(https?:\/\/|\/(?![/\\]))/i.test(block.props.link.trim()) ? block.props.link.trim() : "";
    if (!link || !block.props.url || !block.props.showPreview) return out;
    const image = out.dom.tagName === "IMG" ? out.dom : out.dom.querySelector("img");
    if (!image) return out;
    const anchor = document.createElement("a");
    anchor.href = link;
    image.replaceWith(anchor);
    anchor.appendChild(image);
    return out.dom === image ? { ...out, dom: anchor } : out;
  },
  runsBefore: ["file"],
});

// ---------------------------------------------------------------------------------------------
// Markdown

export type LinkedImage = { url: string; name: string; caption: string; link: string };

const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unattr = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** An image block's Markdown when it links somewhere (null when it doesn't, or shows no image). */
export function linkedImageMarkdown(props: Record<string, unknown> | undefined): string | null {
  const link = parseImageLink(props?.link)?.href;
  const url = typeof props?.url === "string" ? props.url.trim() : "";
  if (!link || !url || props?.showPreview === false) return null;
  const name = typeof props?.name === "string" ? props.name : "";
  const caption = typeof props?.caption === "string" ? props.caption.replace(/\s*\n\s*/g, " ").trim() : "";
  if (caption) {
    return `<figure><a href="${attr(link)}"><img alt="${attr(name)}" src="${attr(url)}"></a><figcaption>${attr(caption)}</figcaption></figure>`;
  }
  return `[![${markdownLinkText(name)}](${markdownLinkDestination(url)})](${markdownLinkDestination(link)})`;
}

const DESTINATION = String.raw`(<[^<>\n]*>|[^\s()<>]+)`;
const LINKED_IMAGE_LINE = new RegExp(String.raw`^ {0,3}\[!\[((?:\\.|[^\\\]])*)\]\(${DESTINATION}(?:\s+"[^"\n]*")?\)\]\(${DESTINATION}\)\s*$`);
const LINKED_FIGURE_LINE = /^ {0,3}<figure><a href="([^"]*)"><img alt="([^"]*)" src="([^"]*)"\s*\/?><\/a>(?:<figcaption>(.*?)<\/figcaption>)?<\/figure>\s*$/;

const destination = (text: string) => text.replace(/^<|>$/g, "");

/**
 * A line of Markdown that is one image in a link (either form above), with a link an image may
 * hold (see parseImageLink; `appUrl` turns absolute links to the app's pages into their paths).
 */
export function parseLinkedImageLine(line: string, appUrl?: string): LinkedImage | null {
  const md = LINKED_IMAGE_LINE.exec(line);
  if (md) {
    const link = parseImageLink(destination(md[3]), appUrl);
    if (!link) return null;
    return { url: destination(md[2]), name: md[1].replace(/\\(.)/g, "$1"), caption: "", link: link.href };
  }
  const figure = LINKED_FIGURE_LINE.exec(line);
  if (!figure) return null;
  const link = parseImageLink(unattr(figure[1]), appUrl);
  if (!link) return null;
  return { url: unattr(figure[3]), name: unattr(figure[2]), caption: unattr(figure[4] ?? ""), link: link.href };
}

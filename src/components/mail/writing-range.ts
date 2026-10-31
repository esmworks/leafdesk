import type { Node as PmNode } from "prosemirror-model";

/**
 * The part of a message in the composer (mail-editor.tsx) that the AI writer (composer-ai.tsx)
 * works on and replaces, and its text as the model reads it: pure functions of the editor's document.
 */

const SIGNATURES = new Set(["signature", "pastedSignature"]);

/**
 * The part of the message the person wrote: from its start to its last line with something on it,
 * before the signature (the mail an answer quotes stays out of the editor, quote.ts). With nothing written,
 * the first empty line, where writing starts.
 */
export function writingRange(doc: PmNode): { from: number; to: number } {
  let to = 0;
  let first: PmNode | null = null;
  let stop = false;
  doc.forEach((node, offset) => {
    if (stop) return;
    if (SIGNATURES.has(node.type.name)) {
      stop = true;
      return;
    }
    first ??= node;
    if (node.textContent.trim() || node.type.name !== "paragraph") to = offset + node.nodeSize;
  });
  const start = first as PmNode | null;
  if (!to && start?.type.name === "paragraph") to = start.nodeSize;
  return { from: 0, to };
}

/**
 * The range's text as the model reads it: a line per paragraph (an empty one is a blank line, as
 * the editor's paragraphs have no space around them), "- " and "1. " list lines, "> " quotes.
 */
export function plainText(doc: PmNode, to: number): string {
  const blocks: string[] = [];
  const write = (node: PmNode, prefix: string) => {
    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      let n = 1;
      node.forEach((item) => {
        const marker = node.type.name === "bulletList" ? "- " : `${n++}. `;
        blocks.push(prefix + marker + item.textBetween(0, item.content.size, " ").trim());
      });
    } else if (node.type.name === "blockquote") node.forEach((child) => write(child, `${prefix}> `));
    else blocks.push(prefix + node.textBetween(0, node.content.size, "\n", "\n"));
  };
  doc.forEach((node, offset) => {
    if (offset < to) write(node, "");
  });
  return blocks.join("\n").trim();
}

const attribute = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The pictures in the range, as the editor reads them back (its `Picture` node): the model reads
 * only text, so what replaces the range keeps them under it rather than dropping them.
 */
export function rangePictures(doc: PmNode, to: number): string {
  const pictures: string[] = [];
  doc.nodesBetween(0, to, (node) => {
    if (node.type.name === "picture" && node.attrs.cid) {
      const alt = node.attrs.alt ? ` alt="${attribute(node.attrs.alt)}"` : "";
      pictures.push(`<img src="${attribute(node.attrs.src)}" data-cid="${attribute(node.attrs.cid)}"${alt}>`);
    }
  });
  return pictures.join("");
}

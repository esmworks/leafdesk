import type { Node as PmNode } from "prosemirror-model";

/**
 * The part of a message in the composer (mail-editor.tsx) that the AI writer (composer-ai.tsx)
 * works on and replaces, and its text as the model reads it: pure functions of the editor's document.
 */

const SIGNATURES = new Set(["signature", "pastedSignature"]);

/**
 * The part of the message the person wrote: from its start to its last line with something on it,
 * before the signature or the line the quoted mail starts under (`headers`). With nothing written,
 * the first empty line, where writing starts.
 */
export function writingRange(doc: PmNode, headers: string[]): { from: number; to: number } {
  let to = 0;
  let first: PmNode | null = null;
  let stop = false;
  doc.forEach((node, offset) => {
    if (stop) return;
    if (SIGNATURES.has(node.type.name) || (node.type.name === "paragraph" && headers.includes(node.textContent.trim()))) {
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

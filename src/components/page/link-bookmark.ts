"use client";

import { MENTION } from "@/lib/mentions";
import { BOOKMARK_BLOCK } from "@/lib/web-blocks";
import type { PageEditor } from "./embed-blocks";

/**
 * "Turn into bookmark" for a link in the text (its toolbar, link-mention-toolbar.tsx) and a link
 * shown as a mention (its card, page-preview-card.tsx). Loaded when one is turned, not with the editor.
 */

/** The id of the block whose text holds `pos`. */
function blockIdAt(editor: PageEditor, pos: number): string | null {
  const $pos = editor.prosemirrorState.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer") return typeof node.attrs.id === "string" ? node.attrs.id : null;
  }
  return null;
}

/**
 * Takes the text from `from` to `to` (a link, or a link mention) out of its block and puts a
 * bookmark of `url` under it, as one change; a paragraph left empty becomes the bookmark. The
 * bookmark fetches its details as it is drawn (web-blocks.tsx).
 */
export function linkToBookmark(editor: PageEditor, from: number, to: number, url: string): boolean {
  const blockId = blockIdAt(editor, from);
  if (!blockId) return false;
  // "Read <link> today" leaves "Read today", not two spaces.
  const doc = editor.prosemirrorState.doc;
  if (from > 0 && to < doc.content.size && doc.textBetween(from - 1, from) === " " && doc.textBetween(to, to + 1) === " ") to += 1;
  const bookmark = { type: BOOKMARK_BLOCK, props: { url } } as never;
  editor.transact(() => {
    editor.transact((tr) => tr.delete(from, to));
    const block = editor.getBlock(blockId);
    if (!block) return;
    const content = Array.isArray(block.content) ? (block.content as { type: string; text?: string }[]) : null;
    const empty = content !== null && content.every((c) => c.type === "text" && !c.text?.trim());
    if (empty && block.type === "paragraph" && !block.children.length) editor.replaceBlocks([blockId], [bookmark]);
    else editor.insertBlocks([bookmark], blockId, "after");
  });
  return true;
}

/** Turns the link mention drawn as `element` into a bookmark of `url`. */
export function mentionToBookmark(editor: PageEditor, element: HTMLElement, url: string): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;
  let pos: number;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return false;
  }
  const doc = view.state.doc;
  // The position found is the mention's own or the one just inside it: look at both.
  for (const at of [pos, pos - 1]) {
    if (at < 0 || at >= doc.content.size) continue;
    const node = doc.nodeAt(at);
    if (node?.type.name === MENTION && node.attrs.url === url) return linkToBookmark(editor, at, at + node.nodeSize, url);
  }
  return false;
}

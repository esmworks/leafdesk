import { createExtension } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { textDirection } from "@/lib/text-direction";

/**
 * Each block of text runs the way its own text does: a block whose first letter is Arabic or Hebrew
 * runs right to left, one starting with a Latin letter left to right, whatever the interface
 * language. The direction goes on the block (`dir` on its outer element), so its list marker, check
 * box and nested blocks follow it too. Blocks without letters yet (a new empty line) keep the
 * direction around them, so typing starts on the side the page runs from. Code stays left to right
 * (see globals.css); tables, columns and embedded views follow the page.
 */

const key = new PluginKey<DecorationSet>("blockDirection");

function decorations(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    if (content?.isTextblock && content.type.name !== "codeBlock") {
      const dir = textDirection(content.textContent);
      if (dir) found.push(Decoration.node(pos, pos + node.nodeSize, { dir }));
    }
    return true;
  });
  return DecorationSet.create(doc, found);
}

export const BlockDirection = createExtension(() => ({
  key: "blockDirection",
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => decorations(state.doc),
        apply: (tr, value) => (tr.docChanged ? decorations(tr.doc) : value),
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
  ],
}));

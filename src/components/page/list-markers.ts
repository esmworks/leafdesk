import { createExtension } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { listMarker, listStyleAt } from "@/lib/list-markers";

/**
 * Numbered lists nested in numbered lists count in letters, then roman numerals, then numbers
 * again (lib/list-markers). BlockNote numbers every item (`data-index`); this adds the marker of a
 * nested item as `data-marker`, which globals.css shows instead. The count follows BlockNote's:
 * consecutive numbered items of one level, from the first one's `start` (or 1).
 */

const key = new PluginKey<DecorationSet>("listMarkers");

/** The markers of nested numbered items; exported for tests. */
export function listMarkerDecorations(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  const walk = (group: PMNode, start: number, depth: number) => {
    let index = 0;
    group.forEach((block, offset) => {
      const pos = start + offset;
      const content = block.firstChild;
      const numbered = block.type.name === "blockContainer" && content?.type.name === "numberedListItem";
      if (numbered) {
        index = index ? index + 1 : Number(content.attrs.start) || 1;
        const style = listStyleAt(depth);
        if (style !== "decimal") found.push(Decoration.node(pos + 1, pos + 1 + content.nodeSize, { "data-marker": listMarker(index, style) }));
      } else {
        index = 0;
      }
      // A block's children sit in a blockGroup after its content; columns hold groups of their own.
      block.forEach((child, childOffset) => {
        if (child.type.name === "blockGroup" || child.type.name === "column" || child.type.name === "columnList") {
          walk(child, pos + 1 + childOffset + 1, numbered ? depth + 1 : child.type.name === "blockGroup" ? depth : 0);
        }
      });
    });
  };
  walk(doc.firstChild ?? doc, 1, 0);
  return DecorationSet.create(doc, found);
}

export const ListMarkers = createExtension(() => ({
  key: "listMarkers",
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => listMarkerDecorations(state.doc),
        apply: (tr, value) => (tr.docChanged ? listMarkerDecorations(tr.doc) : value),
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
  ],
}));

import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * `| ` and `" ` at the start of a paragraph turn it into a quote, as `> ` does (BlockNote's own
 * rule). The `"` may already be a typographic “ by then (smart-quotes.ts). Only a paragraph that
 * holds nothing but the mark: a quotation being typed (`"Hello`) never gets a space right after
 * its opening quote.
 */

/** Whether typing `typed` after `text`, all a paragraph holds, starts a quote. */
export function startsQuote(text: string, typed: string): boolean {
  return typed === " " && (text === "|" || text === '"' || text === "“");
}

const key = new PluginKey("quoteShortcut");

export const QuoteShortcut = createExtension(({ editor }) => ({
  key: "quoteShortcut",
  prosemirrorPlugins: [
    new Plugin({
      key,
      props: {
        handleTextInput(view, from, to, text) {
          if (view.composing || !view.editable || from !== to) return false;
          const $from = view.state.doc.resolve(from);
          const node = $from.parent;
          if (node.type.name !== "paragraph" || $from.parentOffset !== node.content.size) return false;
          if (!startsQuote(node.textContent, text)) return false;
          const block = editor.getTextCursorPosition().block;
          if (block.type !== "paragraph") return false;
          editor.updateBlock(block, { type: "quote", content: [] });
          editor.setTextCursorPosition(block.id, "start");
          return true;
        },
      },
    }),
  ],
}));

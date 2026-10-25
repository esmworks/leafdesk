import { createExtension } from "@blocknote/core";
import { Mapping } from "prosemirror-transform";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import type { QuoteSize } from "@/lib/quote-block";
import { changedRanges } from "./toggle-headings";

/**
 * New quotes take the size last picked in a quote's block menu (quote-size-item.tsx), kept in this
 * browser. A quote is new when its block wasn't a quote before the change (typed `> `, turned into,
 * pasted or split off); the size rides along with that change, one undo step. Changes from others
 * and undoing come through the collaboration document and are left alone.
 */

const KEY = "leafdesk:quote-size";

export function rememberQuoteSize(size: QuoteSize) {
  try {
    if (size === "default") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, size);
  } catch {}
}

function lastQuoteSize(): QuoteSize {
  try {
    return localStorage.getItem(KEY) === "large" ? "large" : "default";
  } catch {
    return "default";
  }
}

/** Where the quotes the transactions made start (their content nodes), in the new document. */
export function newQuotes(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): number[] {
  const doc = newState.doc;
  const back = new Mapping();
  for (const tr of transactions) back.appendMapping(tr.mapping);
  const inverse = back.invert();
  const seen = new Set<number>();
  const out: number[] = [];
  for (const { from, to } of changedRanges(transactions)) {
    if (from > doc.content.size) continue;
    doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, Math.max(to, from + 1)), (node, pos) => {
      if (node.type.name !== "quote") return !node.isTextblock;
      if (seen.has(pos)) return false;
      seen.add(pos);
      const block = doc.nodeAt(pos - 1);
      const was = oldState.doc.nodeAt(inverse.map(pos - 1));
      const wasQuote = was && block && was.attrs.id === block.attrs.id && was.firstChild?.type.name === "quote";
      if (!wasQuote) out.push(pos);
      return false;
    });
  }
  return out;
}

export function quoteSizePlugin(size: () => QuoteSize = lastQuoteSize) {
  return new Plugin({
    key: new PluginKey("leafdeskQuoteSize"),
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
      const wanted = size();
      if (wanted === "default") return null;
      const tr = newState.tr;
      for (const pos of newQuotes(transactions, oldState, newState)) {
        if (newState.doc.nodeAt(pos)?.attrs.size !== wanted) tr.setNodeAttribute(pos, "size", wanted);
      }
      return tr.docChanged ? tr : null;
    },
  });
}

export const QuoteSizeDefault = createExtension(() => ({
  key: "leafdeskQuoteSize",
  prosemirrorPlugins: [quoteSizePlugin()],
}));

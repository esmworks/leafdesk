import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { INLINE_MATH, MATH_BLOCK, MERMAID_BLOCK } from "@/lib/content-block-names";
import { isStraightQuote, smartQuote } from "@/lib/smart-quotes";

/**
 * Quotes typed in a page become typographic ones (lib/smart-quotes): “ ” and ‘ ’, with ’ in
 * contractions. Not in code, code blocks, equations or diagram sources, which take what is typed.
 * Backspace right after one puts the straight quote back.
 */

/** The last quote this made: where it is and what was typed, while nothing else changed. */
type Last = { pos: number; typed: string } | null;

const key = new PluginKey<Last>("smartQuotes");

/** Blocks and inline nodes whose text is a source rather than prose. */
const SOURCES = new Set(["codeBlock", MATH_BLOCK, INLINE_MATH, MERMAID_BLOCK]);

function inProse(state: EditorState, from: number) {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code || SOURCES.has($from.parent.type.name)) return false;
  const marks = state.storedMarks ?? $from.marks();
  return !marks.some((mark) => mark.type.name === "code");
}

function handleTextInput(view: EditorView, from: number, to: number, text: string) {
  if (!isStraightQuote(text) || view.composing || !view.editable) return false;
  const { state } = view;
  if (!inProse(state, from)) return false;
  const $from = state.doc.resolve(from);
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const quote = smartQuote(before, text);
  const tr = state.tr.insertText(quote, from, to);
  view.dispatch(tr.setMeta(key, { pos: tr.mapping.map(from, -1), typed: text } satisfies Last));
  return true;
}

function handleBackspace(view: EditorView) {
  const last = key.getState(view.state);
  const { selection } = view.state;
  if (!last || !selection.empty || selection.from !== last.pos + 1) return false;
  view.dispatch(view.state.tr.insertText(last.typed, last.pos, last.pos + 1));
  return true;
}

export const SmartQuotes = createExtension(() => ({
  key: "smartQuotes",
  // Ahead of the editor's own Backspace, which would delete the quote.
  keyboardShortcuts: {
    Backspace: ({ editor }) => (editor.prosemirrorView ? handleBackspace(editor.prosemirrorView) : false),
  },
  prosemirrorPlugins: [
    new Plugin<Last>({
      key,
      state: {
        init: () => null,
        // Kept only until anything else happens: a later change or a move forgets it.
        apply: (tr, last) => (tr.getMeta(key) as Last | undefined) ?? (tr.docChanged || tr.selectionSet ? null : last),
      },
      props: { handleTextInput },
    }),
  ],
}));

import { createExtension } from "@blocknote/core";
import type { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { FOOTNOTE } from "@/lib/content-block-names";
import { openSearch } from "@/lib/search-open";
import { NOT_PROSE, SOURCE_BLOCKS } from "@/lib/tag-blocks";
import { findTags, typedTag } from "@/lib/tags";

/**
 * `#tags` in a page (lib/tags) stay plain text; this only marks them (a decoration, never a change
 * to the document) and opens the search box with one that is clicked: right away where the page
 * can't be edited, with Ctrl or Cmd held where it can (a plain click puts the caret in it). Text
 * is read as the index reads it (lib/tag-blocks): not in code, equations, diagram sources, links
 * or mentions, a footnote's text on its own.
 */

const key = new PluginKey<DecorationSet>("tagMarks");

/** Text marked as code or as a link isn't prose. */
const proseText = (node: PMNode) => node.isText && !node.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link");

/** Marks the tags in the inline content of `parent`, which starts at `start`. */
function markInline(parent: PMNode, start: number, found: Decoration[]) {
  // The run of prose being read, and the position of its first character.
  let text = "";
  let from = start;
  const flush = () => {
    if (!text.includes("#")) return;
    for (const tag of findTags(text)) found.push(Decoration.inline(from + tag.start, from + tag.end, { class: "leafdesk-tag", "data-tag": tag.label }));
  };
  parent.forEach((child, offset) => {
    const at = start + offset;
    if (proseText(child)) {
      if (!text) from = at;
      text += child.text;
      return;
    }
    flush();
    // What isn't prose stands as one character before the text after it, as the index reads it.
    text = NOT_PROSE;
    from = at + child.nodeSize - 1;
    if (child.type.name === FOOTNOTE && child.content.size) markInline(child, at + 1, found);
  });
  flush();
}

/** The tags of a document, marked; exported for tests. */
export function tagDecorations(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code && !SOURCE_BLOCKS.has(node.type.name)) markInline(node, pos + 1, found);
    return false;
  });
  return DecorationSet.create(doc, found);
}

/**
 * The tag being typed at the caret: where its `#` is in the document and what follows it so far.
 * Null when the caret isn't right after one in prose; exported for tests and the tag menu.
 */
export function tagAtCaret(state: EditorState): { from: number; query: string } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code || SOURCE_BLOCKS.has(block.type.name)) return null;
  if ((state.storedMarks ?? $from.marks()).some((mark) => mark.type.name === "code" || mark.type.name === "link")) return null;
  const before = block.textBetween(0, $from.parentOffset, undefined, NOT_PROSE);
  if (!before.includes("#")) return null;
  // At the end of the tag, not inside it.
  if (/^[\p{L}\p{M}\p{N}_\-/]/u.test(block.textBetween($from.parentOffset, Math.min($from.parentOffset + 2, block.content.size), undefined, NOT_PROSE))) return null;
  const typed = typedTag(before);
  if (!typed) return null;
  const from = $from.start() + typed.start;
  // Positions count a footnote's text differently from the text read here: none then.
  if (state.doc.textBetween(from, from + 1) !== "#") return null;
  // The whole tag is prose (no code or link inside it).
  let prose = true;
  state.doc.nodesBetween(from, $from.pos, (node) => {
    if (node.isInline && !proseText(node)) prose = false;
  });
  return prose ? { from, query: typed.query } : null;
}

function onClick(view: EditorView, event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest("[data-tag]") : null;
  const tag = target?.getAttribute("data-tag");
  if (!tag || (view.editable && !(event.metaKey || event.ctrlKey))) return false;
  event.preventDefault();
  openSearch(`#${tag}`);
  return true;
}

/** The plugin marking a page's tags; exported for tests. */
export function tagMarksPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => tagDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? tagDecorations(tr.doc) : value),
    },
    props: {
      decorations: (state) => key.getState(state),
      handleDOMEvents: { click: onClick },
    },
  });
}

export const TagMarks = createExtension(() => ({ key: "tagMarks", prosemirrorPlugins: [tagMarksPlugin()] }));

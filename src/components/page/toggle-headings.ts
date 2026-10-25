import { createExtension } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping, type Step } from "prosemirror-transform";
import { ySyncPluginKey } from "y-prosemirror";

/**
 * A heading made a toggle heading takes the blocks under it as its children: the ones after it,
 * up to the next heading of the same or a higher level (fewer #), so the section folds away under
 * it. Made a plain heading again, it lets them out after it. The change is appended to the one that
 * made it (one undo step, and one change for the others editing the page); changes from the
 * others, and undoing, come through the collaboration document and are left alone. A paragraph
 * turned straight into a toggle heading takes nothing: it had no section.
 */

type Turned = { pos: number; toggle: boolean };

/** Where in `doc` the transactions changed something, as ranges of the final document. */
export function changedRanges(transactions: readonly Transaction[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  transactions.forEach((tr, i) => {
    tr.steps.forEach((step, j) => {
      const after = new Mapping();
      after.appendMapping(tr.mapping.slice(j + 1));
      for (const later of transactions.slice(i + 1)) after.appendMapping(later.mapping);
      // An attribute set on its own (setNodeAttribute) maps no range; its JSON says where. By its
      // JSON rather than its class, which may come from another copy of the library.
      const json = (step as Step).toJSON() as { stepType?: string; pos?: number };
      if (json.stepType === "attr" && typeof json.pos === "number") {
        const at = after.map(json.pos);
        ranges.push({ from: at, to: at + 1 });
        return;
      }
      step.getMap().forEach((_from, _to, from, to) => ranges.push({ from: after.map(from, -1), to: after.map(to) }));
    });
  });
  return ranges;
}

const toggleable = (node: PMNode | null | undefined) => node?.type.name === "heading" && node.attrs.isToggleable === true;

/** Headings the transactions turned into toggle headings (or back), by where their blocks start. */
function turnedHeadings(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): Turned[] {
  const doc = newState.doc;
  const back = new Mapping();
  for (const tr of transactions) back.appendMapping(tr.mapping);
  const inverse = back.invert();
  const seen = new Set<number>();
  const out: Turned[] = [];
  for (const { from, to } of changedRanges(transactions)) {
    if (from > doc.content.size) continue;
    doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, Math.max(to, from + 1)), (node, pos) => {
      if (node.type.name !== "heading") return !node.isTextblock;
      const container = pos - 1;
      if (seen.has(container)) return false;
      seen.add(container);
      const block = doc.nodeAt(container);
      if (!block?.attrs.id) return false;
      const was = oldState.doc.nodeAt(inverse.map(container));
      // Only a heading that was one before, by the same block.
      if (!was || was.attrs.id !== block.attrs.id || was.firstChild?.type.name !== "heading") return false;
      const now = toggleable(node);
      if (now !== toggleable(was.firstChild)) out.push({ pos: container, toggle: now });
      return false;
    });
  }
  return out;
}

/** Keeps a toggle heading that just took its section open, so the blocks don't seem to vanish. */
function keepOpen(id: string) {
  try {
    window.localStorage.setItem(`toggle-${id}`, "true");
  } catch {
    // Without storage it shows closed, as any toggle does there.
  }
}

/** Moves the section after the heading block at `pos` into it. */
function wrap(tr: Transaction, pos: number) {
  const block = tr.doc.nodeAt(pos);
  const heading = block?.firstChild;
  if (!block || heading?.type.name !== "heading") return;
  const $block = tr.doc.resolve(pos);
  const group = $block.parent;
  const level = Number(heading.attrs.level) || 1;
  const section: PMNode[] = [];
  for (let i = $block.index() + 1; i < group.childCount; i++) {
    const next = group.child(i);
    const first = next.firstChild;
    if (first?.type.name === "heading" && (Number(first.attrs.level) || 1) <= level) break;
    section.push(next);
  }
  if (!section.length) return;
  const children = block.childCount > 1 ? block.child(1) : null;
  const groupType = children?.type ?? group.type;
  const inner = groupType.create(children?.attrs ?? null, [...(children ? children.content.content : []), ...section]);
  const end = pos + block.nodeSize + section.reduce((size, node) => size + node.nodeSize, 0);
  tr.replaceWith(pos, end, block.type.create(block.attrs, [heading, inner], block.marks));
  keepOpen(String(block.attrs.id));
}

/** Moves the children of the heading block at `pos` out, after it. */
function unwrap(tr: Transaction, pos: number) {
  const block = tr.doc.nodeAt(pos);
  if (!block || block.childCount < 2 || block.firstChild?.type.name !== "heading") return;
  const children = block.child(1).content.content;
  tr.replaceWith(pos, pos + block.nodeSize, [block.type.create(block.attrs, [block.firstChild], block.marks), ...children]);
}

/** The plugin on its own, for tests. */
export function toggleHeadingPlugin() {
  return new Plugin({
    key: new PluginKey("leafdeskToggleHeadingSections"),
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
      const turned = turnedHeadings(transactions, oldState, newState);
      if (!turned.length) return null;
      const tr = newState.tr;
      // Last first, so the places before stay where they are.
      for (const { pos, toggle } of turned.sort((a, b) => b.pos - a.pos)) {
        const at = tr.mapping.map(pos);
        if (toggle) wrap(tr, at);
        else unwrap(tr, at);
      }
      return tr.docChanged ? tr : null;
    },
  });
}

export const ToggleHeadingSections = createExtension(() => ({
  key: "leafdeskToggleHeadingSections",
  prosemirrorPlugins: [toggleHeadingPlugin()],
}));

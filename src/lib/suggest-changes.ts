import { Fragment, Slice, type Mark, type Node } from "prosemirror-model";
import { TextSelection, Transaction, type EditorState } from "prosemirror-state";
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, replaceStep, Transform, type Step } from "prosemirror-transform";
import {
  formattingOf,
  isSuggestionMarkName,
  markOf,
  resolveSuggestions,
  sameFormatting,
  suggestionAuthor,
  suggestionMarkEnd,
  suggestionMarkTypes,
  ZWSP,
  type SuggestionMarkTypes,
} from "@/lib/suggestions";

/**
 * Turns an editor's change into the same change suggested (lib/suggestions): text it deletes is
 * marked deleted instead, text it inserts is marked inserted, formatting it changes is marked with
 * what it was. Adapted from @handlewithcare/prosemirror-suggest-changes 0.1.8 (MIT, see NOTICE),
 * changed so that
 *
 * - suggestions are someone's: a change joins the author's own suggestion next to it, never
 *   someone else's, deletes for real only the author's own inserted text, and leaves other people's
 *   suggestions as they are;
 * - every mark is inline (blocks carry none through Yjs): a whole new or deleted block is marked on
 *   its text, an empty one on a zero-width space, with one more at the end of the block before it
 *   so accepting or rejecting removes the block rather than its text alone;
 * - formatting is a `modification` of the text rather than its deletion and insertion again.
 *
 * Changes it can't suggest (a block's type or color, a block without text such as an image) are
 * made as they are and reported as `untracked`: people who may only comment can't make those.
 */

export type SuggestContext = {
  /** The user the suggestion is by. */
  authorId: string;
  /** A new suggestion's id (lib/suggestions newSuggestionId). */
  newId: () => string;
};

type Ctx = SuggestContext & { types: SuggestionMarkTypes; id: string; untracked: boolean; selectionEmpty: boolean };

const idOf = (mark: Mark | null | undefined) => (mark && typeof mark.attrs.id === "string" ? mark.attrs.id : null);
const mine = (mark: Mark | null | undefined, ctx: Ctx): mark is Mark => Boolean(mark && suggestionAuthor(idOf(mark)) === ctx.authorId);

/** Maps a position of the original change onto the suggested one built so far. */
function rebasePos(pos: number, back: Step[], forth: Step[]) {
  const reset = back.reduceRight((acc, step) => step.getMap().invert().map(acc), pos);
  return forth.reduce((acc, step) => step.getMap().map(acc), reset);
}

/** Content a change inserts, without suggestion marks it may carry (text dragged from a suggestion). */
function cleanFragment(fragment: Fragment): Fragment {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    const marks = node.marks.filter((m) => !isSuggestionMarkName(m.type.name));
    const content = node.isText ? null : cleanFragment(node.content);
    nodes.push(node.isText ? node.mark(marks) : node.type.create(node.attrs, content, marks));
  });
  return Fragment.from(nodes);
}

const cleanSlice = (slice: Slice) => new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd);

/** The content a range holds with its suggestions accepted, to put back marked as new. */
function acceptedRange(doc: Node, from: number, to: number): Slice {
  const range = doc.resolve(from).blockRange(doc.resolve(to));
  if (!range) return doc.slice(from, to);
  const tr = new Transform(doc);
  resolveSuggestions(tr, "accept");
  return cleanSlice(tr.doc.slice(tr.mapping.map(from), tr.mapping.map(to)));
}

/**
 * Puts a marked zero-width space at the end of the textblock right before `from` (else at the
 * start of the one right after `to`), so a run of whole blocks starts or ends inside a block that
 * stays: accepting or rejecting deletes from there, which removes the blocks in between.
 */
function anchorBlocks(tracked: Transform, from: number, to: number, mark: Mark) {
  let before: { end: number } | null = null;
  let after: { start: number } | null = null;
  tracked.doc.descendants((node, pos) => {
    if (after) return false;
    if (!node.isTextblock) return true;
    if (pos + node.nodeSize <= from) before = { end: pos + node.nodeSize - 1 };
    else if (pos >= to) after = { start: pos + 1 };
    return false;
  });
  const at = (before as { end: number } | null)?.end ?? (after as { start: number } | null)?.start;
  if (at === undefined) return;
  tracked.insert(at, tracked.doc.type.schema.text(ZWSP, [mark]));
}

/** Marks `from`–`to` deleted by `id`: text no suggestion holds yet (others' stay as they are). */
function markDeleted(tracked: Transform, from: number, to: number, id: string, ctx: Ctx) {
  const { deletion, insertion } = ctx.types;
  const mark = deletion.create({ id });
  const ranges: { from: number; to: number }[] = [];
  const empty: number[] = [];
  tracked.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock && node.content.size === 0 && pos >= from && pos + node.nodeSize <= to) empty.push(pos + 1);
    if (!node.isInline) return true;
    if (markOf(node, insertion) || markOf(node, deletion)) return false;
    ranges.push({ from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to) });
    return false;
  });
  for (const r of ranges) tracked.addMark(r.from, r.to, mark);
  // An empty block that goes shows as a struck-through space.
  for (const pos of empty.reverse()) tracked.insert(pos, tracked.doc.type.schema.text(ZWSP, [mark]));
  return empty.length;
}

/** Marks `from`–`to`, just inserted, as inserted by `id`; returns how many spaces it added. */
function markInserted(tracked: Transform, from: number, to: number, id: string, ctx: Ctx) {
  const mark = ctx.types.insertion.create({ id });
  const empty: number[] = [];
  tracked.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock && node.content.size === 0 && pos >= from && pos + node.nodeSize <= to) empty.push(pos + 1);
    if (!node.isInline) return true;
    tracked.addMark(Math.max(pos, from), Math.min(pos + node.nodeSize, to), mark);
    return false;
  });
  for (const pos of empty.reverse()) tracked.insert(pos, tracked.doc.type.schema.text(ZWSP, [mark]));
  return empty.length;
}

/** Whether `from`–`to` is exactly a range of whole blocks. */
function wholeBlocks(doc: Node, from: number, to: number) {
  if (from === to) return false;
  const range = doc.resolve(from).blockRange(doc.resolve(to));
  return Boolean(range && range.start === from && range.end === to && !doc.resolve(from).parent.isTextblock);
}

/** A replace step suggested (see the top of the file). Returns whether it used the new id. */
function suggestReplace(tracked: Transform, doc: Node, step: ReplaceStep, prevSteps: Step[], ctx: Ctx): boolean {
  const { deletion, insertion } = ctx.types;
  // The author's own suggestion right before or after the change: it grows that one.
  const nodeBefore = doc.resolve(step.from).nodeBefore;
  const nodeAfter = doc.resolve(step.to).nodeAfter;
  const ownMark = (node: Node | null | undefined) => [markOf(node, deletion), markOf(node, insertion)].find((m) => mine(m, ctx)) ?? null;
  const markBefore = ownMark(nodeBefore);
  const markAfter = ownMark(nodeAfter);
  const markId = idOf(markBefore) ?? idOf(markAfter) ?? ctx.id;

  let stepFrom = rebasePos(step.from, prevSteps, tracked.steps);
  let stepTo = rebasePos(step.to, prevSteps, tracked.steps);
  if (tracked instanceof Transaction && ctx.selectionEmpty && stepFrom !== stepTo) {
    tracked.setSelection(TextSelection.near(tracked.doc.resolve(stepFrom)));
  }

  // The author's own inserted text in the range goes for real.
  const own: { from: number; to: number }[] = [];
  tracked.doc.nodesBetween(stepFrom, stepTo, (node, pos) => {
    if (!node.isInline) return true;
    if (mine(markOf(node, insertion), ctx)) own.push({ from: Math.max(pos, stepFrom), to: Math.min(pos + node.nodeSize, stepTo) });
    return false;
  });
  for (const range of own.reverse()) tracked.delete(range.from, range.to);
  stepFrom = rebasePos(step.from, prevSteps, tracked.steps);
  stepTo = rebasePos(step.to, prevSteps, tracked.steps);

  if (stepFrom !== stepTo) {
    let $stepFrom = tracked.doc.resolve(stepFrom);
    let $stepTo = tracked.doc.resolve(stepTo);
    const whole = wholeBlocks(tracked.doc, stepFrom, stepTo);
    if (!whole) {
      // A deletion across a block boundary with nothing to mark on one side gets a space to mark.
      if ($stepFrom.parent.isTextblock && !$stepFrom.nodeAfter && !markOf($stepFrom.nodeBefore, deletion)) {
        tracked.insert(stepFrom, tracked.doc.type.schema.text(ZWSP));
        stepTo++;
        $stepTo = tracked.doc.resolve(stepTo);
      }
      if ($stepTo.parent.isTextblock && !$stepTo.nodeBefore && !markOf($stepTo.nodeAfter, deletion)) {
        tracked.insert(stepTo, tracked.doc.type.schema.text(ZWSP));
        stepTo++;
        $stepTo = tracked.doc.resolve(stepTo);
      }
      // A space right next to another deletion's: the marks join, one space does.
      if ($stepFrom.nodeBefore?.text?.endsWith(ZWSP) && !$stepTo.nodeAfter?.text?.startsWith(ZWSP) && mine(markOf($stepFrom.nodeBefore, deletion), ctx)) {
        tracked.delete(stepFrom - 1, stepFrom);
        stepFrom--;
        stepTo--;
        $stepFrom = tracked.doc.resolve(stepFrom);
        $stepTo = tracked.doc.resolve(stepTo);
      }
      if ($stepTo.nodeAfter?.text?.startsWith(ZWSP) && !$stepFrom.nodeBefore?.text?.endsWith(ZWSP) && mine(markOf($stepTo.nodeAfter, deletion), ctx)) {
        tracked.delete(stepTo, stepTo + 1);
      }
      // Deleting just a space the author doesn't see deletes the character before it instead.
      if ($stepFrom.nodeBefore && stepTo - stepFrom === 1 && tracked.doc.textBetween(stepFrom, stepTo) === ZWSP) {
        tracked.delete(stepFrom, stepTo);
        stepFrom--;
        stepTo--;
        $stepFrom = tracked.doc.resolve(stepFrom);
        if (tracked instanceof Transaction) tracked.setSelection(TextSelection.near($stepFrom));
      }
    }
    const added = markDeleted(tracked, stepFrom, stepTo, markId, ctx);
    stepTo += added;
    if (whole) {
      const beforeAnchor = tracked.steps.length;
      anchorBlocks(tracked, stepFrom, stepTo, deletion.create({ id: markId }));
      if (tracked.steps.length > beforeAnchor) {
        stepFrom = tracked.steps[tracked.steps.length - 1].getMap().map(stepFrom);
        stepTo = tracked.steps[tracked.steps.length - 1].getMap().map(stepTo);
      }
    }
  }

  // The author's own suggestion right after the change, under another id of theirs, joins this one.
  if (nodeAfter && markAfter && idOf(markAfter) !== markId) {
    const end = stepTo + nodeAfter.nodeSize;
    tracked.removeMark(stepTo, end, markAfter.type);
    tracked.addMark(stepTo, end, markAfter.type.create({ id: markId }));
  }

  if (step.slice.content.size) {
    const $to = tracked.doc.resolve(stepTo);
    // Not inside a deletion: after it.
    const insertFrom = suggestionMarkEnd($to, deletion);
    tracked.replace(insertFrom, insertFrom, cleanSlice(step.slice));
    let insertedTo = tracked.steps[tracked.steps.length - 1].getMap().map(insertFrom);
    if (insertedTo > insertFrom) {
      insertedTo += markInserted(tracked, insertFrom, insertedTo, markId, ctx);
      const mark = insertion.create({ id: markId });
      if (wholeBlocks(tracked.doc, insertFrom, insertedTo)) {
        anchorBlocks(tracked, insertFrom, insertedTo, mark);
      } else {
        // A new block boundary: a marked space on either side of it, when nothing else is there.
        const $insertFrom = tracked.doc.resolve(insertFrom);
        if ($insertFrom.parent.isTextblock && !$insertFrom.nodeAfter) {
          tracked.insert(insertFrom, tracked.doc.type.schema.text(ZWSP, [mark]));
          insertedTo++;
        }
        const $insertedTo = tracked.doc.resolve(insertedTo);
        if ($insertedTo.parent.isTextblock && !$insertedTo.nodeBefore) {
          tracked.insert(insertedTo, tracked.doc.type.schema.text(ZWSP, [mark]));
          insertedTo++;
        }
      }
      if (tracked instanceof Transaction && insertFrom !== $to.pos) {
        tracked.setSelection(TextSelection.near(tracked.doc.resolve(insertFrom + step.slice.size)));
      }
    }
  }
  return markId === ctx.id;
}

/**
 * A formatting change suggested: the text takes the new formatting and a `modification` mark with
 * what it had before. Text the author inserted just changes; deleted text and other people's
 * suggestions are left alone.
 */
function suggestFormatting(tracked: Transform, step: AddMarkStep | RemoveMarkStep, prevSteps: Step[], ctx: Ctx): boolean {
  const { insertion, deletion, modification } = ctx.types;
  const from = rebasePos(step.from, prevSteps, tracked.steps);
  const to = rebasePos(step.to, prevSteps, tracked.steps);
  if (isSuggestionMarkName(step.mark.type.name) || step.mark.type.name === "comment") return untracked(tracked, step, prevSteps, ctx);
  const add = step instanceof AddMarkStep;
  const pieces: { from: number; to: number; previous: unknown; id: string }[] = [];
  tracked.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    const inserted = markOf(node, insertion);
    if (inserted) {
      if (mine(inserted, ctx)) pieces.push({ from: start, to: end, previous: null, id: "" });
      return false;
    }
    if (markOf(node, deletion)) return false;
    const modified = markOf(node, modification);
    if (modified && !mine(modified, ctx)) return false;
    pieces.push({ from: start, to: end, previous: modified ? modified.attrs.previous : formattingOf(node.marks), id: idOf(modified) ?? ctx.id });
    return false;
  });
  let usedNew = false;
  for (const piece of pieces) {
    if (add) tracked.addMark(piece.from, piece.to, step.mark);
    else tracked.removeMark(piece.from, piece.to, step.mark);
    if (!piece.id) continue;
    tracked.doc.nodesBetween(piece.from, piece.to, (node, pos) => {
      if (!node.isInline) return true;
      const start = Math.max(pos, piece.from);
      const end = Math.min(pos + node.nodeSize, piece.to);
      // Back to how it was: no suggestion left.
      if (sameFormatting(formattingOf(node.marks), piece.previous)) tracked.removeMark(start, end, modification);
      else {
        tracked.addMark(start, end, modification.create({ id: piece.id, previous: piece.previous }));
        if (piece.id === ctx.id) usedNew = true;
      }
      return false;
    });
  }
  return usedNew;
}

/** A step that can't be suggested: made as it is. */
function untracked(tracked: Transform, step: Step, prevSteps: Step[], ctx: Ctx): boolean {
  ctx.untracked = true;
  const reset = prevSteps.reduceRight<Step | null>((acc, s) => acc?.map(s.getMap().invert()) ?? null, step);
  const rebased = tracked.steps.reduce<Step | null>((acc, s) => acc?.map(s.getMap()) ?? null, reset);
  if (rebased) tracked.maybeStep(rebased);
  return false;
}

/** A replace-around step (lifting, wrapping, a block's type): the blocks again, marked as new. */
function suggestReplaceAround(tracked: Transform, doc: Node, step: ReplaceAroundStep, prevSteps: Step[], ctx: Ctx): boolean {
  // A node's type or attributes alone (setNodeMarkup): no mark can say so.
  if (step.insert === 1 && step.slice.size === 2 && step.gapTo === step.to - 1 && step.gapFrom === step.from + 1 && step.structure) {
    return untracked(tracked, step, prevSteps, ctx);
  }
  const applied = step.apply(doc).doc;
  if (!applied) return false;
  const from = step.getMap().map(step.from, -1);
  const to = step.getMap().map(step.to, 1);
  const range = applied.resolve(from).blockRange(applied.resolve(to));
  if (!range) return untracked(tracked, step, prevSteps, ctx);
  const back = step.getMap().invert();
  const replace = replaceStep(doc, back.map(range.start), back.map(range.end), acceptedRange(applied, range.start, range.end));
  if (!(replace instanceof ReplaceStep)) return untracked(tracked, step, prevSteps, ctx);
  return suggestReplace(tracked, doc, replace, prevSteps, ctx);
}

/**
 * Adds to `tracked` the steps that suggest the change `steps` makes to `docs[0]` (`docs[i]` being
 * the document before step i). Returns whether some step couldn't be suggested (made as it is).
 */
export function suggestSteps(
  tracked: Transform,
  steps: readonly Step[],
  docs: readonly Node[],
  context: SuggestContext,
  { selectionEmpty = true }: { selectionEmpty?: boolean } = {},
): { untracked: boolean } {
  const types = suggestionMarkTypes(tracked.doc.type.schema);
  if (!types) throw new Error("The schema has no suggestion marks");
  const ctx: Ctx = { ...context, types, id: context.newId(), untracked: false, selectionEmpty };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const doc = docs[i];
    const prev = steps.slice(0, i);
    let usedId = false;
    if (step instanceof ReplaceStep) usedId = suggestReplace(tracked, doc, step, prev, ctx);
    else if (step instanceof ReplaceAroundStep) usedId = suggestReplaceAround(tracked, doc, step, prev, ctx);
    else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) usedId = suggestFormatting(tracked, step, prev, ctx);
    else usedId = untracked(tracked, step, prev, ctx);
    // A later step that starts a suggestion of its own gets a new id.
    if (usedId) ctx.id = context.newId();
  }
  return { untracked: ctx.untracked };
}

/**
 * The transaction that suggests what `original` does, from the editor's `state` (as a
 * dispatchTransaction hook sees them), with the original's selection, stored marks and meta.
 */
export function suggestTransaction(original: Transaction, state: EditorState, context: SuggestContext): { tr: Transaction; untracked: boolean } {
  const tr = state.tr;
  const { untracked: missed } = suggestSteps(tr, original.steps, original.docs, context, { selectionEmpty: state.selection.empty });
  if (original.selectionSet && !tr.selectionSet) {
    const base = original.docs[0] ? original.selection.map(original.docs[0], original.mapping.invert()) : original.selection;
    tr.setSelection(base.map(tr.doc, tr.mapping));
  }
  if (original.scrolledIntoView) tr.scrollIntoView();
  if (original.storedMarksSet) tr.setStoredMarks(original.storedMarks);
  // The original's meta, as it is (y-sync, history and other plugins read it).
  (tr as unknown as { meta: unknown }).meta = (original as unknown as { meta: unknown }).meta;
  return { tr, untracked: missed };
}

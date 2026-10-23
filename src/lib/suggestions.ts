import { Fragment, type Mark, type MarkType, type Node, type ResolvedPos, type Schema } from "prosemirror-model";
import { Transform } from "prosemirror-transform";

/**
 * Suggested edits in a page's body: changes proposed instead of made, for people who may edit the
 * page to accept or reject. They are marks on the text, in the page's live document like any other
 * text, so everyone with the page open sees them as they are typed:
 *
 * - `insertion`: text someone proposes to add. Rejecting it removes the text.
 * - `deletion`: text someone proposes to remove; it stays in the page, struck through, until
 *   accepted.
 * - `modification`: text whose formatting someone proposes to change; it carries the formatting it
 *   had before (`previous`), which rejecting puts back.
 *
 * Every mark is inline: the editor's Yjs binding (y-prosemirror 1.x) keeps no marks on blocks, so a
 * new block is marked on its text, and an empty one on a zero-width space (ZWSP) put in for it.
 * A block boundary proposed (Enter) or removed (deleting across two blocks) carries such a space on
 * either side, marked like the change (lib/suggest-changes).
 *
 * A suggestion is the marks sharing an id, `<author's user id>:<random part>`. Typing on next to
 * one's own suggestion grows it; next to someone else's starts a new one. The page reads as if no
 * suggestion was made until one is accepted (`rejectedView`): its Markdown, text, search, history,
 * published copy and exports leave pending insertions out and keep pending deletions.
 */

export const INSERTION = "insertion";
export const DELETION = "deletion";
export const MODIFICATION = "modification";
export const SUGGESTION_MARKS = [INSERTION, DELETION, MODIFICATION] as const;
export type SuggestionMarkName = (typeof SUGGESTION_MARKS)[number];

/** Stands in for a block boundary or an empty block a suggestion adds or removes. */
export const ZWSP = "​";

const AI_PART = "ai-";

/** A new suggestion's id, for `authorId`; `ai` when an AI writes it for them. */
export function newSuggestionId(authorId: string, { ai = false }: { ai?: boolean } = {}): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, "0")).join("");
  return `${authorId}:${ai ? AI_PART : ""}${random}`;
}

/** The user a suggestion id names as its author, or null for an id that names none. */
export function suggestionAuthor(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const at = id.lastIndexOf(":");
  return at > 0 && at < id.length - 1 ? id.slice(0, at) : null;
}

/** Whether an AI proposed the suggestion (for its author). */
export const isAiSuggestion = (id: string) => id.slice(id.lastIndexOf(":") + 1).startsWith(AI_PART);

/** Longest suggestion id the server accepts: a user id and the random part. */
export const MAX_SUGGESTION_ID = 200;

export const isSuggestionMarkName = (name: string): name is SuggestionMarkName => (SUGGESTION_MARKS as readonly string[]).includes(name);

export type SuggestionMarkTypes = { insertion: MarkType; deletion: MarkType; modification: MarkType };

/** The schema's suggestion marks, or null when it has none (an editor without the extension). */
export function suggestionMarkTypes(schema: Schema): SuggestionMarkTypes | null {
  const { insertion, deletion, modification } = schema.marks;
  return insertion && deletion && modification ? { insertion, deletion, modification } : null;
}

const idOf = (mark: Mark | null | undefined): string | null => (mark && typeof mark.attrs.id === "string" ? mark.attrs.id : null);

/** The suggestion mark of `type` on a node, if any. */
export const markOf = (node: Node | null | undefined, type: MarkType): Mark | undefined => node?.marks.find((m) => m.type === type);

/** Formatting marks (everything but comments and suggestions), as JSON, to compare and to restore. */
export function formattingOf(marks: readonly Mark[]): { type: string; attrs?: Record<string, unknown> }[] {
  return marks
    .filter((m) => !isSuggestionMarkName(m.type.name) && m.type.name !== "comment")
    .map((m) => m.toJSON() as { type: string; attrs?: Record<string, unknown> });
}

export const sameFormatting = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Whether a document holds any suggestion. */
export function hasSuggestions(doc: Node): boolean {
  const types = suggestionMarkTypes(doc.type.schema);
  if (!types) return false;
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isInline && node.marks.some((m) => m.type === types.insertion || m.type === types.deletion || m.type === types.modification)) found = true;
    return !found;
  });
  return found;
}

export type SuggestionSummary = {
  id: string;
  authorId: string | null;
  /** Text it adds and removes (block boundaries as line breaks), as the page shows it. */
  inserted: string;
  deleted: string;
  /** It changes the formatting of some text. */
  formatted: boolean;
  /** The text whose formatting it changes. */
  reformatted: string;
  /** Where it starts in the document, to list suggestions in the order of the page. */
  from: number;
};

/** The document's suggestions, in the order they start in it. */
export function listSuggestions(doc: Node): SuggestionSummary[] {
  const types = suggestionMarkTypes(doc.type.schema);
  if (!types) return [];
  // `last`: the block each kind of change was last seen in, to tell a new block of it.
  const found = new Map<string, SuggestionSummary & { last: Record<"inserted" | "deleted" | "reformatted", Node | null> }>();
  doc.descendants((node, pos, parent) => {
    if (!node.isInline) return true;
    const text = (node.isText ? (node.text ?? "") : "￼").replaceAll(ZWSP, "");
    for (const mark of node.marks) {
      const key = mark.type === types.insertion ? "inserted" : mark.type === types.deletion ? "deleted" : mark.type === types.modification ? "reformatted" : null;
      const id = idOf(mark);
      if (!key || !id) continue;
      let entry = found.get(id);
      if (!entry) {
        entry = {
          id,
          authorId: suggestionAuthor(id),
          inserted: "",
          deleted: "",
          formatted: false,
          reformatted: "",
          from: pos,
          last: { inserted: null, deleted: null, reformatted: null },
        };
        found.set(id, entry);
      }
      if (key === "reformatted") entry.formatted = true;
      // A new block of the same change: a line break between their texts.
      if (entry.last[key] && entry.last[key] !== parent && entry[key]) entry[key] += "\n";
      entry.last[key] = parent;
      entry[key] += text;
    }
    return false;
  });
  return [...found.values()].sort((a, b) => a.from - b.from).map(({ last: _last, ...summary }) => summary);
}

/**
 * Where the run of `type` marks with the id of the one at `$pos` ends: on through the start of
 * following blocks while they start with the same suggestion (a change across a block boundary).
 */
export function suggestionMarkEnd($pos: ResolvedPos, type: MarkType): number {
  const initial = markOf($pos.nodeAfter ?? $pos.nodeBefore, type);
  if (!initial) return $pos.pos;
  const doc = $pos.doc;
  let afterPos = $pos.pos + ($pos.nodeAfter?.nodeSize ?? 0);
  for (let guard = 0; guard < 100_000; guard++) {
    const $after = doc.resolve(afterPos);
    if ($after.depth < 1 || ($after.nodeAfter && !type.isInSet($after.marks()))) return $after.pos;
    if ($after.nodeAfter) {
      // Still inside the run (text split by other marks): go on past this piece.
      const mark = markOf($after.nodeAfter, type);
      if (!mark || idOf(mark) !== idOf(initial)) return $after.pos;
      afterPos = $after.pos + $after.nodeAfter.nodeSize;
      continue;
    }
    // At the end of a textblock: on into the next one when it starts with the same suggestion.
    let afterParentPos = $after.after();
    let $afterParent = doc.resolve(afterParentPos);
    let nextParent = $afterParent.nodeAfter;
    while ($afterParent.depth > 0 && !nextParent) {
      afterParentPos = $after.after($afterParent.depth);
      $afterParent = doc.resolve(afterParentPos);
      nextParent = $afterParent.nodeAfter;
    }
    let cousinStart = afterParentPos + 1;
    let cousin = nextParent?.firstChild;
    while (cousin && !cousin.isLeaf && !cousin.isInline && !type.isInSet(cousin.marks)) {
      cousin = cousin.firstChild;
      cousinStart++;
    }
    const mark = markOf(cousin, type);
    if (!cousin || !mark || idOf(mark) !== idOf(initial)) return $after.pos;
    afterPos = cousinStart + cousin.nodeSize;
  }
  return $pos.pos;
}

export type Decision = "accept" | "reject";

/**
 * Accepts or rejects the suggestions whose id `which` picks: accepting keeps inserted text and new
 * formatting and removes deleted text; rejecting removes inserted text, keeps deleted text and puts
 * the formatting back. Either way their marks go, and with them the zero-width spaces the change put
 * in. Adds the steps to `tr`; the other suggestions stay as they are.
 */
export function resolveSuggestions(tr: Transform, decision: Decision, which: (id: string) => boolean = () => true): void {
  const types = suggestionMarkTypes(tr.doc.type.schema);
  if (!types) return;
  const remove = decision === "accept" ? types.deletion : types.insertion;
  const keep = decision === "accept" ? types.insertion : types.deletion;
  const picked = (node: Node, type: MarkType) => {
    const mark = markOf(node, type);
    const id = idOf(mark);
    return mark && id && which(id) ? mark : undefined;
  };

  // Text to remove, then marks to drop on the text that stays (keeping their zero-width spaces out).
  const original = tr.doc;
  original.descendants((node, pos) => {
    if (!node.isInline) return true;
    if (picked(node, remove)) {
      const { pos: from, deleted } = tr.mapping.mapResult(pos);
      if (deleted) return false;
      const $from = tr.doc.resolve(from);
      // The node may have been joined into a run that started before it: that run is gone already.
      if (!markOf($from.nodeAfter, remove)) return false;
      const to = suggestionMarkEnd($from, remove);
      removeRange(tr, from, to);
      return false;
    }
    const kept = picked(node, keep);
    if (kept) {
      const from = tr.mapping.map(pos);
      const to = tr.mapping.map(pos + node.nodeSize);
      tr.removeMark(from, to, kept);
      if (node.isText && node.text?.includes(ZWSP)) deleteZwsp(tr, from, node.text);
    }
    return false;
  });

  // Formatting changes: kept as they are, or put back as they were.
  const modified: { from: number; to: number; mark: Mark }[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = picked(node, types.modification);
    if (mark) modified.push({ from: pos, to: pos + node.nodeSize, mark });
    return false;
  });
  for (const { from, to, mark } of modified) {
    tr.removeMark(from, to, mark);
    if (decision === "accept") continue;
    const previous = Array.isArray(mark.attrs.previous) ? (mark.attrs.previous as unknown[]) : [];
    const schema = tr.doc.type.schema;
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true;
      for (const m of node.marks) if (!isSuggestionMarkName(m.type.name) && m.type.name !== "comment") tr.removeMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), m);
      return false;
    });
    for (const json of previous) {
      try {
        tr.addMark(from, to, schema.markFromJSON(json));
      } catch {
        // A mark this schema doesn't know: left off.
      }
    }
  }
}

/** Deletes the zero-width spaces of a text node that starts at `from`. */
function deleteZwsp(tr: Transform, from: number, text: string) {
  for (let i = text.length - 1; i >= 0; i--) if (text[i] === ZWSP) tr.delete(from + i, from + i + 1);
}

/** Removes a suggestion's run of text from `from` to `to` (joining the blocks a boundary in it splits). */
function removeRange(tr: Transform, from: number, to: number) {
  // Two spaces left side by side once a word goes: one of them goes too.
  const before = tr.doc.textBetween(Math.max(0, from - 1), from, "x", "x");
  const after = to < tr.doc.content.size ? tr.doc.textBetween(to, to + 1, "x", "x") : "";
  tr.deleteRange(from, to + (before === " " && after === " " ? 1 : 0));
}

/** The document with the suggestions `which` picks accepted or rejected. */
export function resolvedDoc(doc: Node, decision: Decision, which?: (id: string) => boolean): Node {
  const tr = new Transform(doc);
  resolveSuggestions(tr, decision, which);
  return tr.doc;
}

/** The page as it reads with no pending suggestion applied (see the top of this file). */
export const rejectedView = (doc: Node): Node => (hasSuggestions(doc) ? resolvedDoc(doc, "reject") : doc);

/** The document without `authorId`'s own suggestions (rejected), everyone else's left as they are. */
export const withoutSuggestionsOf = (doc: Node, authorId: string): Node => resolvedDoc(doc, "reject", (id) => suggestionAuthor(id) === authorId);

/**
 * Whether going from `before` to `after` changes nothing but `authorId`'s own suggestions: what
 * people who may only comment are allowed to write (see server/collab/suggest-guard.ts). An empty
 * last block the editor adds on its own (it keeps one at the end of the page) doesn't count.
 */
export function onlySuggestionsOf(before: Node, after: Node, authorId: string): boolean {
  return withoutTrailingEmpty(withoutSuggestionsOf(before, authorId)).eq(withoutTrailingEmpty(withoutSuggestionsOf(after, authorId)));
}

/** The body without the empty paragraphs at its very end (BlockNote: doc > blockGroup > blockContainer). */
function withoutTrailingEmpty(doc: Node): Node {
  const group = doc.firstChild;
  if (!group || doc.childCount !== 1) return doc;
  const empty = (block: Node) =>
    block.childCount === 1 && block.firstChild!.type.name === "paragraph" && block.firstChild!.content.size === 0;
  let count = group.childCount;
  while (count > 1 && empty(group.child(count - 1))) count--;
  if (count === group.childCount) return doc;
  const blocks: Node[] = [];
  for (let i = 0; i < count; i++) blocks.push(group.child(i));
  return doc.copy(Fragment.from(group.copy(Fragment.from(blocks))));
}

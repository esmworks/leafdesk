import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { _blocksToProsemirrorNode, YjsThreadStore } from "@blocknote/core/yjs";
import { Fragment, type Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { suggestionOfThread, THREADS_MAP, type CommentBody } from "@/lib/comments";
import {
  hasSuggestions,
  listSuggestions,
  rejectedView,
  resolvedDoc,
  resolveSuggestions,
  suggestionAuthor,
  suggestionMarkTypes,
  type Decision,
  type SuggestionSummary,
} from "@/lib/suggestions";
import { serverEditor as editor, type PageBlock } from "@/server/blocknote";

/**
 * Suggested edits (lib/suggestions) in a page's live document, on the server: reading the body
 * with them, writing it without losing them, accepting and rejecting them, and the comment thread
 * each one has.
 */

const schema = () => editor.editor.pmSchema;

/** The body with its suggestion marks, as ProseMirror reads it. */
export const bodyRoot = (fragment: Y.XmlFragment): Node => yXmlFragmentToProseMirrorRootNode(fragment, schema());

/** Writes a body back, diffed against what the fragment holds (unchanged blocks keep their Yjs identity). */
const writeRoot = (fragment: Y.XmlFragment, root: Node) => prosemirrorToYXmlFragment(root, fragment);

const withoutComments = (node: Node): Node => {
  const comment = schema().marks.comment;
  if (!comment) return node;
  const tr = new Transform(node);
  tr.removeMark(0, node.content.size, comment);
  return tr.doc;
};

/** Every blockContainer of a body by id. */
function containersOf(root: Node): Map<string, Node> {
  const found = new Map<string, Node>();
  root.descendants((node) => {
    if (node.type.name === "blockContainer" && typeof node.attrs.id === "string") found.set(node.attrs.id, node);
    return !node.isTextblock;
  });
  return found;
}

/**
 * Writes `next`, blocks of the page as it reads (synced-body fragmentBlocks: pending suggestions
 * not applied), into the body. Suggestions stay in every block the write leaves as the page read
 * it, when they are the block's own (a suggestion across a block boundary, such as a proposed new
 * paragraph, belongs to two); in the blocks it changes they go, and the page reads on as written.
 * So a write from MCP, the REST API, the AI or a restore never applies a suggestion by accident.
 */
export function writeBlocksKeepingSuggestions(fragment: Y.XmlFragment, next: PageBlock[]) {
  const raw = bodyRoot(fragment);
  if (!hasSuggestions(raw)) {
    editor.blocksToYXmlFragment(next, fragment);
    return;
  }
  const read = containersOf(rejectedView(raw));
  const before = containersOf(raw);
  const target = _blocksToProsemirrorNode(editor.editor, next as never) as Node;
  const keep = (node: Node): Node => {
    if (node.isTextblock || node.isLeaf) return node;
    const children: Node[] = [];
    node.forEach((child) => children.push(keep(child)));
    let content = Fragment.from(children);
    if (node.type.name === "blockContainer" && typeof node.attrs.id === "string" && node.firstChild) {
      const was = before.get(node.attrs.id);
      const readAs = read.get(node.attrs.id);
      const own = was?.firstChild;
      // The block's content as written is what the page read, and its suggestions are its own
      // (rejected on their own they give that very content).
      if (
        own &&
        readAs?.firstChild &&
        withoutComments(node.firstChild).eq(withoutComments(readAs.firstChild)) &&
        resolvedDoc(own, "reject").eq(readAs.firstChild)
      ) {
        content = content.replaceChild(0, own);
      }
    }
    return node.copy(content);
  };
  writeRoot(fragment, keep(target));
}

/**
 * Accepts or rejects suggestions in the body: `ids`, or all of them. Returns the ids it found (the
 * others were answered or withdrawn already). Run it inside the document's transaction.
 */
export function resolveInFragment(fragment: Y.XmlFragment, decision: Decision, ids: string[] | null): string[] {
  const raw = bodyRoot(fragment);
  const present = new Set(listSuggestions(raw).map((s) => s.id));
  const found = ids ? ids.filter((id) => present.has(id)) : [...present];
  if (!found.length) return [];
  const picked = new Set(found);
  const tr = new Transform(raw);
  resolveSuggestions(tr, decision, (id) => picked.has(id));
  writeRoot(fragment, tr.doc);
  return found;
}

/** The body's suggestions (see lib/suggestions listSuggestions). */
export const suggestionsIn = (doc: Y.Doc): SuggestionSummary[] => listSuggestions(bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT)));

/** Most characters of a suggestion's text its thread quotes. */
const QUOTE = 280;
const clip = (text: string) => (text.length > QUOTE ? `${text.slice(0, QUOTE)}…` : text);

/**
 * What a suggestion's thread says it does: the text it removes struck through, the text it adds,
 * the text it reformats; "¶" for a change of only a block boundary. Words of the page only, so it
 * reads the same in every language; the comments panel says what kind of change it is.
 */
export function suggestionBody(summary: SuggestionSummary): CommentBody {
  const paragraph = (text: string, strike = false): CommentBody[number] => ({
    type: "paragraph",
    content: [{ type: "text", text: clip(text), styles: strike ? { strike: true } : {} }],
  });
  const body: CommentBody = [];
  if (summary.deleted.trim()) body.push(paragraph(summary.deleted.trim(), true));
  if (summary.inserted.trim()) body.push(paragraph(summary.inserted.trim()));
  if (summary.formatted && summary.reformatted.trim()) body.push(paragraph(summary.reformatted.trim()));
  return body.length ? body : [paragraph("¶")];
}

type ThreadOf = { threadId: string; suggestionId: string; resolved: boolean; firstCommentId: string | null; firstBody: unknown };

function suggestionThreads(threads: Y.Map<unknown>): ThreadOf[] {
  const found: ThreadOf[] = [];
  for (const [threadId, thread] of threads.entries()) {
    if (!(thread instanceof Y.Map)) continue;
    const suggestionId = suggestionOfThread(thread.get("metadata"));
    if (!suggestionId) continue;
    const first = (thread.get("comments") as Y.Array<Y.Map<unknown>> | undefined)?.get(0);
    found.push({
      threadId,
      suggestionId,
      resolved: Boolean(thread.get("resolved")),
      firstCommentId: (first?.get("id") as string | undefined) ?? null,
      firstBody: first?.get("body"),
    });
  }
  return found;
}

export type SuggestionThreadChanges = {
  /** Threads opened for new suggestions, by their author. */
  opened: { threadId: string; suggestionId: string; authorId: string }[];
  /** Threads of suggestions that are gone (withdrawn by their author, or answered). */
  closed: { threadId: string; suggestionId: string }[];
};

/**
 * Gives every suggestion of the body its comment thread, opened by its author, with the text it
 * changes as the first comment and the comment mark on that text (so the thread sits next to it in
 * the comments, and selecting the text selects the thread); updates that comment while the author
 * goes on; and resolves the thread of a suggestion that is gone. `writers`: who changed the page
 * since the last save. A suggestion is someone's when its id names them (lib/suggestions), and the
 * server opens a thread in their name only when they are among the writers.
 */
export function syncSuggestionThreads(doc: Y.Doc, writers: ReadonlySet<string>, origin: unknown): SuggestionThreadChanges {
  const changes: SuggestionThreadChanges = { opened: [], closed: [] };
  const threads = doc.getMap(THREADS_MAP);
  const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
  const known = suggestionThreads(threads);
  const raw = bodyRoot(fragment);
  const types = suggestionMarkTypes(raw.type.schema);
  if (!types || (!known.length && !hasSuggestions(raw))) return changes;
  const suggestions = listSuggestions(raw);
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const threadOf = new Map(known.map((t) => [t.suggestionId, t]));

  doc.transact(() => {
    for (const summary of suggestions) {
      const thread = threadOf.get(summary.id);
      const authorId = summary.authorId;
      if (!authorId) continue;
      const store = new YjsThreadStore(authorId, threads, new DefaultThreadStoreAuth(authorId, "editor"));
      const body = suggestionBody(summary);
      if (!thread) {
        if (!writers.has(authorId)) continue;
        const before = new Set(threads.keys());
        void store.createThread({ initialComment: { body: body as never }, metadata: { suggestion: summary.id } }).catch(() => {});
        const created = [...threads.keys()].find((id) => !before.has(id));
        if (created) {
          threadOf.set(summary.id, { threadId: created, suggestionId: summary.id, resolved: false, firstCommentId: null, firstBody: body });
          changes.opened.push({ threadId: created, suggestionId: summary.id, authorId });
        }
      } else if (thread.firstCommentId && JSON.stringify(thread.firstBody) !== JSON.stringify(body)) {
        void store.updateComment({ threadId: thread.threadId, commentId: thread.firstCommentId, comment: { body: body as never } }).catch(() => {});
      }
    }
    for (const thread of known) {
      if (byId.has(thread.suggestionId) || thread.resolved) continue;
      const authorId = suggestionAuthor(thread.suggestionId) ?? "";
      const store = new YjsThreadStore(authorId, threads, new DefaultThreadStoreAuth(authorId, "editor"));
      void store.resolveThread({ threadId: thread.threadId }).catch(() => {});
      changes.closed.push({ threadId: thread.threadId, suggestionId: thread.suggestionId });
    }

    // The comment mark of each suggestion's thread on all of its text.
    const comment = raw.type.schema.marks.comment;
    if (!comment) return;
    const tr = new Transform(raw);
    raw.descendants((node, pos) => {
      if (!node.isInline) return true;
      for (const mark of node.marks) {
        if (mark.type !== types.insertion && mark.type !== types.deletion && mark.type !== types.modification) continue;
        const thread = threadOf.get(mark.attrs.id as string);
        if (!thread) continue;
        if (!node.marks.some((m) => m.type === comment && m.attrs.threadId === thread.threadId)) {
          tr.addMark(pos, pos + node.nodeSize, comment.create({ orphan: false, threadId: thread.threadId }));
        }
      }
      return false;
    });
    if (tr.docChanged) writeRoot(fragment, tr.doc);
  }, origin);
  return changes;
}

/** Resolves the threads of answered suggestions, as the person who answered them. */
export function resolveSuggestionThreads(doc: Y.Doc, suggestionIds: string[], userId: string) {
  const threads = doc.getMap(THREADS_MAP);
  const wanted = new Set(suggestionIds);
  const store = new YjsThreadStore(userId, threads, new DefaultThreadStoreAuth(userId, "editor"));
  const resolved: { threadId: string; suggestionId: string }[] = [];
  for (const thread of suggestionThreads(threads)) {
    if (!wanted.has(thread.suggestionId) || thread.resolved) continue;
    void store.resolveThread({ threadId: thread.threadId }).catch(() => {});
    resolved.push({ threadId: thread.threadId, suggestionId: thread.suggestionId });
  }
  return resolved;
}

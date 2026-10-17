import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "./collab-constants";

/**
 * Synced blocks: a group of blocks kept on one page (the source) and shown live on other pages
 * (references). Both are the same block, `syncedBlock`, holding only `pageId` and `syncId`: it is
 * the source when `pageId` is the page it sits in, and a reference anywhere else. So a source copied
 * (or pasted, or duplicated with its page and not remapped) onto another page reads there as a
 * reference to it, and nothing has to tell the two kinds apart when blocks move between pages.
 *
 * The blocks themselves live in the source page's own document, in a fragment of their own
 * (`synced:<syncId>`, next to the page body's fragment): the source shows an editor on it, and a
 * reference opens the source page's document with its reader's own access to that page and shows
 * an editor on the same fragment. Whoever may edit the source page edits the blocks from either;
 * whoever may only view it reads them; whoever can't see it gets the collab server's refusal, and
 * the reference says "No access" and nothing more.
 *
 * In Markdown (stored for search and history, read and written by MCP, exported) a synced block is
 * the blocks between two marker lines; a reference stores no blocks between them (they are the
 * source page's), and readers fill them in for whoever reads (server/synced-blocks.ts):
 *
 *   <!-- leafdesk:synced-block <pageId> <syncId> -->
 *   …
 *   <!-- leafdesk:synced-block-end -->
 *
 * Synced blocks don't nest: the blocks of one never hold another (source or reference). Editors
 * refuse it and every reader drops one found there anyway, so no chain of references can loop.
 *
 * This file is pure and shared by the editor and the server.
 */

export const SYNCED_BLOCK = "syncedBlock";

export const syncedBlockConfig = {
  type: SYNCED_BLOCK,
  propSchema: { pageId: { default: "" }, syncId: { default: "" } },
  content: "none",
} as const;

export type SyncedRef = { pageId: string; syncId: string };

const ID = /^[\w-]{1,128}$/;

/** The ids a synced block holds, or null when either is missing or malformed. */
export function syncedRefOf(props: unknown): SyncedRef | null {
  if (!props || typeof props !== "object") return null;
  const { pageId, syncId } = props as { pageId?: unknown; syncId?: unknown };
  if (typeof pageId !== "string" || typeof syncId !== "string" || !ID.test(pageId) || !ID.test(syncId)) return null;
  return { pageId, syncId };
}

export const syncedKey = (ref: SyncedRef) => `${ref.pageId}:${ref.syncId}`;

/** The Yjs fragment of the source page's document holding a synced block's blocks. */
export const syncedFragmentName = (syncId: string) => `synced:${syncId}`;

export const newSyncId = () => crypto.randomUUID();

/** The block is the source of its blocks (it sits in the page that holds them). */
export const isSyncedSource = (ref: SyncedRef, hostPageId: string) => ref.pageId === hostPageId;

// ---------------------------------------------------------------------------------------------
// What a reader sees

/** Access levels, as server/access ranks them. */
export type SyncedAccessLevel = "none" | "view" | "comment" | "edit" | "full";

/**
 * What a synced block shows its reader:
 * - `editable`: the blocks, edited in place (they edit the source page);
 * - `readOnly`: the blocks, read only (view or comment access, or the source page is locked);
 * - `noAccess`: nothing of the source page, not even whether it exists;
 * - `trashed`: the source page is in the trash;
 * - `deleted`: the source page is gone;
 * - `removed`: the source page is there but its synced block was deleted from it.
 */
export type SyncedState = "editable" | "readOnly" | "noAccess" | "trashed" | "deleted" | "removed";

/** The source page as the server found it for one reader (null: no such page). */
export type SyncedSourceFacts = {
  level: SyncedAccessLevel;
  /** The reader's session is held back from the page's workspace (two-step or SSO policy). */
  heldBack: boolean;
  archived: boolean;
  locked: boolean;
  kind: "page" | "database";
} | null;

/**
 * The state of a synced block's source page for one reader, before looking for the block in it.
 * A page the reader can't see reads the same whether it exists or not, and whether it is in the
 * trash: "noAccess" is decided first.
 */
export function syncedSourceState(facts: SyncedSourceFacts): Exclude<SyncedState, "removed"> {
  if (facts && (facts.level === "none" || facts.heldBack)) return "noAccess";
  if (!facts) return "deleted";
  if (facts.archived) return "trashed";
  const canEdit = facts.level === "edit" || facts.level === "full";
  return canEdit && !facts.locked ? "editable" : "readOnly";
}

/** The final state, once it is known whether the source page still holds the block. */
export function syncedState(source: Exclude<SyncedState, "removed">, present: boolean): SyncedState {
  if (source !== "editable" && source !== "readOnly") return source;
  return present ? source : "removed";
}

/** States in which the reader sees the blocks. */
export const showsSyncedContent = (state: SyncedState) => state === "editable" || state === "readOnly";

// ---------------------------------------------------------------------------------------------
// Block trees

/** The part of a BlockNote block these helpers read; the server passes full blocks through. */
type AnyBlock = { type: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/** The synced blocks of a block tree, in document order (nested ones included), with their ids. */
export function syncedBlocksIn(blocks: AnyBlock[]): (SyncedRef & { blockId: string })[] {
  const out: (SyncedRef & { blockId: string })[] = [];
  const walk = (list: AnyBlock[]) => {
    for (const block of list) {
      if (block.type === SYNCED_BLOCK) {
        const ref = syncedRefOf(block.props);
        if (ref) out.push({ ...ref, blockId: String((block as { id?: unknown }).id ?? "") });
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * Replaces each synced block with `replace(block, ref)` (none, one or several blocks), depth first,
 * keeping the rest of the tree. A synced block without valid ids goes.
 */
export function mapSyncedBlocks<B extends AnyBlock>(blocks: B[], replace: (block: B, ref: SyncedRef) => B[]): B[] {
  return blocks.flatMap((block): B[] => {
    if (block.type === SYNCED_BLOCK) {
      const ref = syncedRefOf(block.props);
      return ref ? replace(block, ref) : [];
    }
    return block.children?.length ? [{ ...block, children: mapSyncedBlocks(block.children as B[], replace) }] : [block];
  });
}

/** The blocks of a synced block as readers get them: without synced blocks inside (they don't nest). */
export const withoutSyncedBlocks = <B extends AnyBlock>(blocks: B[]): B[] => mapSyncedBlocks(blocks, () => []);

/** Block ids taken out, so the blocks can be inserted as new ones (a reference unsynced into a copy). */
export function withoutBlockIds<B extends AnyBlock>(blocks: B[]): B[] {
  return blocks.map((block) => {
    const { id: _id, ...rest } = block as B & { id?: unknown };
    return { ...rest, children: withoutBlockIds((block.children ?? []) as B[]) } as unknown as B;
  });
}

// ---------------------------------------------------------------------------------------------
// Yjs documents

/**
 * The synced blocks the page body of a document holds (Yjs elements, read without converting the
 * body to blocks): the source page uses this to tell which of its blocks it still has.
 */
export function syncedElementsIn(doc: Y.Doc): SyncedRef[] {
  const out: SyncedRef[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === SYNCED_BLOCK) {
        const ref = syncedRefOf({ pageId: child.getAttribute("pageId"), syncId: child.getAttribute("syncId") });
        if (ref) out.push(ref);
      }
      walk(child);
    }
  };
  walk(doc.getXmlFragment(COLLAB_FRAGMENT));
  return out;
}

/** The page body of `doc` (page `pageId`) holds the source of synced block `syncId`. */
export const holdsSyncedSource = (doc: Y.Doc, pageId: string, syncId: string) =>
  syncedElementsIn(doc).some((ref) => ref.pageId === pageId && ref.syncId === syncId);

/**
 * Points the sources of a copied page's document at the copy (`from` → `to`), in place: a
 * duplicated page or a page made from a template gets synced blocks of its own (their blocks were
 * copied with the document), not references to the original's. References elsewhere stay as they
 * are; ones to a page copied along (`map`) point at its copy. Returns how many blocks changed.
 */
export function remapSyncedBlocks(doc: Y.Doc, map: ReadonlyMap<string, string>): number {
  let changed = 0;
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === SYNCED_BLOCK) {
        const next = map.get(String(child.getAttribute("pageId") ?? ""));
        if (next) {
          child.setAttribute("pageId", next);
          changed++;
        }
      }
      walk(child);
    }
  };
  doc.transact(() => walk(doc.getXmlFragment(COLLAB_FRAGMENT)));
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Markdown

const BEGIN_LINE = /^ {0,3}<!--\s*leafdesk:synced-block\s+([\w-]{1,128})\s+([\w-]{1,128})\s*-->\s*$/;
const END_LINE = /^ {0,3}<!--\s*leafdesk:synced-block-end\s*-->\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

export const syncedBeginLine = (ref: SyncedRef) => `<!-- leafdesk:synced-block ${ref.pageId} ${ref.syncId} -->`;
export const SYNCED_END_LINE = "<!-- leafdesk:synced-block-end -->";

export function parseSyncedBegin(line: string): SyncedRef | null {
  const match = BEGIN_LINE.exec(line);
  return match ? { pageId: match[1], syncId: match[2] } : null;
}

type Part = { line: string } | { ref: SyncedRef; begin: string; inner: string[]; end: string | null };

/**
 * Markdown in lines and synced regions (a begin line, the lines up to its end line, the end line).
 * Lines in fenced code are only lines, here and inside regions. A begin line without an end line
 * is a region of its own, with nothing inside; an end line without a begin line is a line.
 */
function scan(markdown: string): Part[] {
  const lines = markdown.split(/\r?\n/);
  const parts: Part[] = [];
  let fence: string | null = null;
  const fenceStep = (line: string) => {
    if (fence) {
      const closing = FENCE_CLOSE.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      return true;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening) fence = opening[1];
    return Boolean(opening);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceStep(line)) {
      parts.push({ line });
      continue;
    }
    const ref = parseSyncedBegin(line);
    if (!ref) {
      parts.push({ line });
      continue;
    }
    // Look for the end line, outside fenced code, and nothing nested: a begin line inside ends the
    // search (the region was never closed).
    const saved: string | null = fence;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (fenceStep(lines[j])) continue;
      if (END_LINE.test(lines[j])) {
        end = j;
        break;
      }
      if (parseSyncedBegin(lines[j])) break;
    }
    fence = saved;
    if (end < 0) {
      parts.push({ ref, begin: line, inner: [], end: null });
      continue;
    }
    parts.push({ ref, begin: line, inner: lines.slice(i + 1, end), end: lines[end] });
    i = end;
  }
  return parts;
}

const joinParts = (parts: Part[]) =>
  parts.flatMap((part) => ("line" in part ? [part.line] : [part.begin, ...part.inner, ...(part.end === null ? [] : [part.end])])).join("\n");

/**
 * Each synced region with only its begin line (what is between is the source page's), for
 * Markdown written into a page: its blocks never come from the Markdown.
 */
export function collapseSyncedRegions(markdown: string): string {
  return scan(markdown)
    .map((part) => ("line" in part ? part.line : syncedBeginLine(part.ref)))
    .join("\n");
}

/**
 * Rewrites synced regions: `replace` gets the region's ids and the Markdown between its lines, and
 * returns what goes between them instead (null keeps the region as it is).
 */
export function mapSyncedRegions(markdown: string, replace: (ref: SyncedRef, inner: string) => string | null): string {
  const parts = scan(markdown).map((part): Part => {
    if ("line" in part) return part;
    const next = replace(part.ref, part.inner.join("\n"));
    if (next === null) return part;
    return { ...part, inner: next ? next.split("\n") : [], end: SYNCED_END_LINE };
  });
  return joinParts(parts);
}

/** The synced regions of Markdown, in order, with what is between their lines. */
export function syncedRegions(markdown: string): { ref: SyncedRef; inner: string }[] {
  return scan(markdown).flatMap((part) => ("line" in part ? [] : [{ ref: part.ref, inner: part.inner.join("\n") }]));
}

/** What a source page's Markdown holds between the lines of its synced block `syncId` (null: no such block). */
export function syncedRegionContent(markdown: string, ref: SyncedRef): string | null {
  const found = syncedRegions(markdown).find((r) => r.ref.pageId === ref.pageId && r.ref.syncId === ref.syncId);
  return found ? found.inner : null;
}

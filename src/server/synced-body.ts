import { docToBlocks } from "@blocknote/core";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import type * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { rejectedView } from "@/lib/suggestions";
import { mapSyncedBlocks, syncedFragmentName, withoutSyncedBlocks } from "@/lib/synced-blocks";
import { serverEditor as editor, type PageBlock } from "@/server/blocknote";

/**
 * The blocks of a fragment of a page's document as the page reads: without the suggested edits
 * that wait for an answer (lib/suggestions rejectedView), inserted text left out and deleted text
 * kept. Everything derived from a body reads it this way: its Markdown and text, search, history,
 * published pages, exports and what MCP, the REST API and the AI see.
 */
export function fragmentBlocks(fragment: Y.XmlFragment): PageBlock[] {
  const root = yXmlFragmentToProseMirrorRootNode(fragment, editor.editor.pmSchema);
  return docToBlocks(rejectedView(root)) as unknown as PageBlock[];
}

/** The blocks of synced block `syncId` kept in `doc` (its source page's), without synced blocks inside. */
export const syncedBlocksOf = (doc: Y.Doc, syncId: string) => withoutSyncedBlocks(fragmentBlocks(doc.getXmlFragment(syncedFragmentName(syncId))));

/**
 * The body of page `pageId` as blocks, each synced block it is the source of holding its blocks
 * as children (lib/synced-blocks): they are part of this page's Markdown, text, links, mentions,
 * search index and history. References hold none: their blocks are another page's, which readers
 * of this page may not be allowed to see. Blocks nested under a synced block in the editor follow
 * it instead, so its Markdown markers enclose only its own blocks. Without `pageId`, the main
 * fragment as it is. Suggested edits read as not made (see fragmentBlocks).
 */
export function bodyBlocks(doc: Y.Doc, pageId: string | undefined) {
  const blocks = fragmentBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
  if (!pageId) return blocks;
  return mapSyncedBlocks(blocks, (block, ref) => [
    { ...block, children: ref.pageId === pageId ? syncedBlocksOf(doc, ref.syncId) : [] },
    ...block.children,
  ]);
}

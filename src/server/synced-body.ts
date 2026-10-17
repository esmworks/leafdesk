import type * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { mapSyncedBlocks, syncedFragmentName, withoutSyncedBlocks } from "@/lib/synced-blocks";
import { serverEditor as editor } from "@/server/blocknote";

/** The blocks of synced block `syncId` kept in `doc` (its source page's), without synced blocks inside. */
export const syncedBlocksOf = (doc: Y.Doc, syncId: string) =>
  withoutSyncedBlocks(editor.yXmlFragmentToBlocks(doc.getXmlFragment(syncedFragmentName(syncId))));

/**
 * The body of page `pageId` as blocks, each synced block it is the source of holding its blocks
 * as children (lib/synced-blocks): they are part of this page's Markdown, text, links, mentions,
 * search index and history. References hold none: their blocks are another page's, which readers
 * of this page may not be allowed to see. Blocks nested under a synced block in the editor follow
 * it instead, so its Markdown markers enclose only its own blocks. Without `pageId`, the main
 * fragment as it is.
 */
export function bodyBlocks(doc: Y.Doc, pageId: string | undefined) {
  const blocks = editor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
  if (!pageId) return blocks;
  return mapSyncedBlocks(blocks, (block, ref) => [
    { ...block, children: ref.pageId === pageId ? syncedBlocksOf(doc, ref.syncId) : [] },
    ...block.children,
  ]);
}

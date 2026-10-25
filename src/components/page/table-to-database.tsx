"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { useTranslations } from "next-intl";
import type { FC } from "react";
import { tableToDatabaseAction } from "@/app/actions/embeds";
import { CALLOUT_BLOCK } from "@/lib/content-blocks";
import { DATABASE_BLOCK } from "@/lib/embed-blocks";
import { SYNCED_BLOCK } from "@/lib/synced-blocks";
import { tableRecords, type TableBlockContent } from "@/lib/table-to-database";
import { useEmbedHost } from "./database-embed";
import { placeEmbedBlock, type PageEditor } from "./embed-blocks";
import { AddMeetingItem } from "./meeting-block";
import { SaveAsSnippetItem } from "./snippets";
import { turnIntoSyncedBlock } from "./synced-block";
import { CalloutStyleItem, CalloutTitleItem } from "./callout-menu";
import { ImageLinkItem } from "./image-link";
import { ImageCropItem } from "./image-crop-item";
import { FormatCodeItem } from "./code-format-item";
import { copyBlockLink } from "./editor-shortcuts";
import { AlignMediaItems, CopyOriginalLinkItem, DownloadMediaItem, OpenLinkedPageItem } from "./media-menu";
import { WideColumnsItem } from "./columns";
import { TurnIntoItem } from "./turn-into-item";

// Tables being turned into a database: a second click waits for the first.
const turning = new Set<string>();

/**
 * "Turn into database" in a table block's side menu, for people who may edit the page: a database
 * under the page made from the table (the first row names the properties, the first column holds
 * the rows' names, every cell as plain text) takes the table's place, in one undo step. Undoing
 * brings the table back; the database stays under the page.
 */
function TurnIntoDatabaseItem({ onError }: { onError: (message: string) => void }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("page.embed");
  if (!block || block.type !== "table" || !host?.editable) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const id = block.id;
        if (turning.has(id)) return;
        turning.add(id);
        // The cells as they are now; the database exists before the block points at it.
        const records = tableRecords(block.content as TableBlockContent);
        void tableToDatabaseAction(host.pageId, records)
          .then((res) => {
            if (!res.ok) return onError(t("convertFailed", { error: res.error }));
            const database = { type: DATABASE_BLOCK, props: { databaseId: res.data.id } } as const;
            // Gone meanwhile (deleted, or the page reloaded): the database goes at the end.
            if (editor.getBlock(id)) editor.updateBlock(id, database);
            else placeEmbedBlock(editor, id, database);
          })
          .catch(() => onError(t("convertFailed", { error: "" })))
          .finally(() => turning.delete(id));
      }}
    >
      {t("turnIntoDatabase")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * "Turn into synced block": the block (or the selected blocks, when it is among them) moves into a
 * new synced block in its place (see synced-block.tsx), in one step. Not for a synced block itself,
 * nor for blocks holding one: synced blocks don't nest.
 */
function TurnIntoSyncedBlockItem({ onError }: { onError: (message: string) => void }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("page.syncedBlock");
  if (!block || block.type === SYNCED_BLOCK || !host?.editable || !host.doc) return null;
  const doc = host.doc;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const selected = editor.getSelection()?.blocks.map((b) => b.id) ?? [];
        const ids = selected.includes(block.id) ? selected : [block.id];
        if (!turnIntoSyncedBlock(editor, doc, host.pageId, ids)) onError(t("nested"));
      }}
    >
      {t("turnInto")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * "Copy link to block" (also Alt+Shift+L, editor-shortcuts.ts): the address of the page with the
 * block's id, which opens the page scrolled to the block and highlights it (block-focus.ts). Pasted
 * into a page, it becomes a mention of the block (mentions.tsx).
 */
function CopyBlockLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("page.blockMenu");
  if (!block || !host) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => void copyBlockLink(host.workspaceId, host.pageId, block.id, editor.domElement ?? document.body)}
    >
      {t("copyLink")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * "Hide when printing" in a callout's side menu: the callout stays on screen but is left out of the
 * print view and of what the browser prints (see lib/content-blocks).
 */
function HideInPrintItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blockMenu");
  if (!block || block.type !== CALLOUT_BLOCK || !editor.isEditable) return null;
  const hidden = Boolean((block.props as { hideInPrint?: boolean }).hideInPrint);
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      checked={hidden}
      onClick={() => {
        if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { hideInPrint: !hidden } });
      }}
    >
      {t("hideInPrint")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * The page editor's side menu (add block, drag handle). Its block menu has the editor's own entries
 * (delete, colors, table headers), the callout's style (or turning a block of text into a callout,
 * callout-menu.tsx), its title, "Copy link to block", for a link to a page "Open in new tab", for
 * a bookmark or embed "Copy link to original", for media "Download" and alignment (media-menu.tsx), in a column "Wide columns" (columns.tsx), for a callout "Hide when printing", for a
 * code block "Format code", for a table "Turn into database", "Turn into synced block" and "Save as snippet"; `onError` shows why
 * a change failed. Made once per editor: a new
 * component each render would close an open menu.
 */
export function pageSideMenu(onError: (message: string) => void): FC<SideMenuProps> {
  function PageDragHandleMenu() {
    const dict = useDictionary();
    return (
      <DragHandleMenu>
        <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
        <TurnIntoItem />
        <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
        <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
        <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
        <CalloutStyleItem />
        <CalloutTitleItem />
        <HideInPrintItem />
        <OpenLinkedPageItem />
        <CopyBlockLinkItem />
        <CopyOriginalLinkItem />
        <DownloadMediaItem />
        <AlignMediaItems />
        <WideColumnsItem />
        <ImageLinkItem />
        <ImageCropItem />
        <FormatCodeItem onError={onError} />
        <TurnIntoDatabaseItem onError={onError} />
        <TurnIntoSyncedBlockItem onError={onError} />
        <SaveAsSnippetItem />
        <AddMeetingItem />
      </DragHandleMenu>
    );
  }
  return function PageSideMenu(props: SideMenuProps) {
    return <SideMenu {...props} dragHandleMenu={PageDragHandleMenu} />;
  };
}

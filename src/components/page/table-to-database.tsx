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
import { DATABASE_BLOCK } from "@/lib/embed-blocks";
import { tableRecords, type TableBlockContent } from "@/lib/table-to-database";
import { useEmbedHost } from "./database-embed";
import { placeEmbedBlock, type PageEditor } from "./embed-blocks";

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
 * The page editor's side menu (add block, drag handle). Its block menu has the editor's own entries
 * (delete, colors, table headers) and, for a table, "Turn into database"; `onError` shows why that
 * failed. Made once per editor: a new component each render would close an open menu.
 */
export function pageSideMenu(onError: (message: string) => void): FC<SideMenuProps> {
  function PageDragHandleMenu() {
    const dict = useDictionary();
    return (
      <DragHandleMenu>
        <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
        <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
        <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
        <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
        <TurnIntoDatabaseItem onError={onError} />
      </DragHandleMenu>
    );
  }
  return function PageSideMenu(props: SideMenuProps) {
    return <SideMenu {...props} dragHandleMenu={PageDragHandleMenu} />;
  };
}

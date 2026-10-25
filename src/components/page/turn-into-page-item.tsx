"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { FileOutput } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import type { PageEditor } from "./embed-blocks";

type AnyBlock = PageEditor["document"][number];

/** Opens the picker for these blocks (collab-editor.tsx keeps the dialog, turn-into-page.tsx, loaded when opened). */
export const TurnIntoPageContext = createContext<((blockIds: string[]) => void) | null>(null);

/** The blocks the menu acts on: those selected, when the block whose handle opened it is one of them. */
function blocksFor(editor: PageEditor, block: AnyBlock): AnyBlock[] {
  const selected = editor.getSelection()?.blocks ?? [];
  return selected.some((other) => other.id === block.id) ? selected : [block];
}

/** "Turn into page in…" in a block's menu: the block (or the selected blocks) as a page elsewhere. */
export function TurnIntoPageItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block }) as AnyBlock | undefined;
  const open = useContext(TurnIntoPageContext);
  const t = useTranslations("page.turnIntoPage");
  if (!block || !open || !editor.isEditable) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" icon={<FileOutput size={16} />} onClick={() => open(blocksFor(editor, block).map((b) => b.id))}>
      {t("menuItem")}
    </Components.Generic.Menu.Item>
  );
}

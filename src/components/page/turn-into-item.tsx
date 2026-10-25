"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState, usePortalElement } from "@blocknote/react";
import {
  ChevronRight,
  Code,
  Columns2,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  Quote,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { canTurnIntoColumns, turnIntoColumns } from "./columns";
import type { PageEditor } from "./embed-blocks";

type AnyBlock = PageEditor["document"][number];

/** The kinds of text block a text block can turn into, as BlockNote's slash menu names them. */
const KINDS = [
  { type: "paragraph", name: "paragraph", icon: <Pilcrow size={16} /> },
  { type: "heading", level: 1, name: "heading", icon: <Heading1 size={16} /> },
  { type: "heading", level: 2, name: "heading_2", icon: <Heading2 size={16} /> },
  { type: "heading", level: 3, name: "heading_3", icon: <Heading3 size={16} /> },
  { type: "bulletListItem", name: "bullet_list", icon: <List size={16} /> },
  { type: "numberedListItem", name: "numbered_list", icon: <ListOrdered size={16} /> },
  { type: "checkListItem", name: "check_list", icon: <ListChecks size={16} /> },
  { type: "toggleListItem", name: "toggle_list", icon: <ChevronRight size={16} /> },
  { type: "quote", name: "quote", icon: <Quote size={16} /> },
  { type: "codeBlock", name: "code_block", icon: <Code size={16} /> },
] as const;

const TEXT_TYPES = new Set<string>(KINDS.map((kind) => kind.type));

/** The blocks the menu acts on: those selected, when the block whose handle opened it is one of them. */
function blocksFor(editor: PageEditor, block: AnyBlock): AnyBlock[] {
  const selected = editor.getSelection()?.blocks ?? [];
  return selected.some((other) => other.id === block.id) ? selected : [block];
}

/**
 * "Turn into" in a block's menu: another kind of text block (for every selected block, when the
 * block is one of them), or columns, the selected blocks one to a column, or a single block with
 * an empty column beside it (see columns.tsx turnIntoColumns).
 */
export function TurnIntoItem() {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block }) as AnyBlock | undefined;
  const t = useTranslations("page.blocks.turnInto");
  const tc = useTranslations("page.blocks.columns");
  if (!block || !editor.isEditable) return null;
  const blocks = blocksFor(editor, block);
  const textual = blocks.every((b) => TEXT_TYPES.has(b.type));
  const columns = canTurnIntoColumns(editor, blocks);
  if (!textual && !columns) return null;
  const dict = editor.dictionary.slash_menu;
  const isKind = (kind: (typeof KINDS)[number]) =>
    blocks.every((b) => b.type === kind.type && (!("level" in kind) || (b.props as { level?: number }).level === kind.level));
  const items: { key: string; label: string; icon: ReactNode; checked?: boolean; run: () => void }[] = [];
  if (textual) {
    for (const kind of KINDS) {
      items.push({
        key: kind.name,
        label: dict[kind.name].title,
        icon: kind.icon,
        checked: isKind(kind),
        run: () =>
          editor.transact(() => {
            for (const b of blocks) {
              if (!editor.getBlock(b.id)) continue;
              editor.updateBlock(b.id, "level" in kind ? { type: kind.type, props: { level: kind.level, isToggleable: false } } : { type: kind.type } as never);
            }
          }),
      });
    }
  }
  if (columns) {
    items.push({
      key: "columns",
      label: blocks.length > 1 ? t("columns", { count: blocks.length }) : tc("two.title"),
      icon: blocks.length === 3 ? <Columns3 size={16} /> : <Columns2 size={16} />,
      run: () => turnIntoColumns(editor, blocks.flatMap((b) => editor.getBlock(b.id) ?? [])),
    });
  }
  return (
    <Components.Generic.Menu.Root position="right" sub portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          {t("title")}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {items.map((item) => (
          <Components.Generic.Menu.Item key={item.key} className="bn-menu-item" icon={item.icon} checked={item.checked} onClick={item.run}>
            {item.label}
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

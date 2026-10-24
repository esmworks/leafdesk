"use client";

import {
  blockHasType,
  defaultProps,
  editorHasBlockWithType,
  mapTableCell,
  type Block,
  type DefaultProps,
  type TableContent,
} from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import type { JSX } from "react";
import type { PageEditor, pageEditorSchema } from "./embed-blocks";

type Schema = typeof pageEditorSchema;
type PageBlock = Block<Schema["blockSchema"], Schema["inlineContentSchema"], Schema["styleSchema"]>;
type PageTable = TableContent<Schema["inlineContentSchema"], Schema["styleSchema"]>;
type Alignment = DefaultProps["textAlignment"];
export type Side = "left" | "center" | "right";

/**
 * Alignment runs with the text (globals.css): the stored "left" is where a block's text starts and
 * "right" where it ends, so a right-to-left block starts on the right without being aligned, and
 * can still be aligned to the left. These buttons stand for sides of the page, so each gives the
 * value that puts the text on its side of the block it aligns.
 */
export const valueFor = (side: Side, rtl: boolean): Alignment => (!rtl || side === "center" ? side : side === "left" ? "right" : "left");

/** Whether a block's text runs right to left, as the editor shows it (block-direction.ts). */
export function runsRtl(editor: PageEditor, blockId: string): boolean {
  const content = editor.domElement?.querySelector(`[data-id="${CSS.escape(blockId)}"] .bn-block-content`);
  return content ? getComputedStyle(content).direction === "rtl" : document.documentElement.dir === "rtl";
}

const hasAlignment = (editor: PageEditor, block: PageBlock) =>
  blockHasType(block, editor, block.type, { textAlignment: defaultProps.textAlignment });

/** The formatting toolbar's align button for one side, as BlockNote's own but by side. */
function SideAlignButton({ side }: { side: Side }) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable) return undefined;
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      const first = blocks[0];
      if (hasAlignment(editor, first)) {
        return { alignment: first.props.textAlignment as Alignment, rtl: runsRtl(editor, first.id), blocks };
      }
      // A table's selected cells, which hold their own alignment.
      if (blocks.length === 1 && blockHasType(first, editor, "table") && editor.getExtension(TableHandlesExtension)?.getCellSelection()) {
        const cell = mapTableCell((first.content as PageTable).rows[0].cells[0]);
        return { alignment: cell.props.textAlignment as Alignment, rtl: runsRtl(editor, first.id), blocks: [first] };
      }
      return undefined;
    },
  });
  if (!state) return null;

  const align = () => {
    editor.focus();
    for (const block of state.blocks) {
      const textAlignment = valueFor(side, runsRtl(editor, block.id));
      if (hasAlignment(editor, block) && editorHasBlockWithType(editor, block.type, { textAlignment: defaultProps.textAlignment })) {
        editor.updateBlock(block, { props: { textAlignment } });
      } else if (block.type === "table") {
        const cells = editor.getExtension(TableHandlesExtension)?.getCellSelection();
        if (!cells) continue;
        const content = block.content as PageTable;
        const rows = content.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => mapTableCell(cell)) }));
        for (const { row, col } of cells.cells) rows[row].cells[col].props.textAlignment = textAlignment;
        editor.updateBlock(block, { type: "table", content: { ...content, type: "tableContent", rows } });
        // updateBlock moves the selection out of the table.
        editor.setTextCursorPosition(block);
      }
    }
  };

  const Icon = side === "left" ? AlignLeft : side === "center" ? AlignCenter : AlignRight;
  const label = dict.formatting_toolbar[`align_${side}`].tooltip;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-test={`alignText${side[0].toUpperCase()}${side.slice(1)}`}
      onClick={align}
      isSelected={state.alignment === valueFor(side, state.rtl)}
      label={label}
      mainTooltip={label}
      icon={<Icon size={16} />}
    />
  );
}

const SIDES: Record<string, Side> = { textAlignLeftButton: "left", textAlignCenterButton: "center", textAlignRightButton: "right" };

/** The formatting toolbar's items with the align buttons by side of the page (SideAlignButton). */
export function withSideAlignButtons(items: JSX.Element[]): JSX.Element[] {
  return items.map((item) => {
    const side = SIDES[String(item.key)];
    return side ? <SideAlignButton key={item.key} side={side} /> : item;
  });
}

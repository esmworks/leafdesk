"use client";

import { createExtension } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState, type DefaultReactSuggestionItem } from "@blocknote/react";
import { BetweenVerticalStart, Columns2, Columns3 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { useCallback } from "react";
import { ySyncPluginKey } from "y-prosemirror";
import {
  COLUMN_BLOCK,
  COLUMN_LIST_BLOCK,
  columnBlockSpecs,
  ColumnListNode,
  ColumnNode,
  columnsWide,
  columnWidth,
  MAX_COLUMNS,
} from "@/lib/columns";
import { inlineSign } from "@/components/direction";
import type { PageEditor } from "./embed-blocks";

/**
 * The editor's side of columns (nodes shared with the server in lib/columns): a handle between
 * columns to resize them, the cleanup that removes a column once its last block is gone, and the
 * slash menu entries. Moving blocks into, out of and between columns is BlockNote's own side menu
 * drag; its core keeps column lists valid when blocks are moved or removed through its API.
 */

/** Narrowest a column may be dragged, in pixels. */
const MIN_COLUMN_PX = 64;

/** A column with a resize handle on its right edge (hidden on the last column, see globals.css). */
const EditorColumnNode = ColumnNode.extend({
  addNodeView() {
    return ({ node: initial, getPos, view, editor }) => {
      let node = initial;
      const dom = document.createElement("div");
      dom.className = "leafdesk-column";
      dom.setAttribute("data-node-type", COLUMN_BLOCK);
      // BlockNote's side menu lines up with the column's first child: the blocks, not the handle.
      const contentDOM = document.createElement("div");
      contentDOM.className = "leafdesk-column-content";
      const handle = document.createElement("div");
      handle.className = "leafdesk-column-resize";
      handle.contentEditable = "false";
      handle.setAttribute("aria-hidden", "true");
      dom.append(contentDOM, handle);

      const sync = () => {
        if (node.attrs.id) dom.setAttribute("data-id", String(node.attrs.id));
        const width = columnWidth(node.attrs.width);
        dom.setAttribute("data-width", String(width));
        dom.style.flexGrow = String(width);
      };
      sync();

      let stop: (() => void) | null = null;
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !editor.isEditable) return;
        const pos = getPos();
        const next = dom.nextElementSibling as HTMLElement | null;
        if (typeof pos !== "number" || !next) return;
        const nextPos = pos + node.nodeSize;
        const nextNode = view.state.doc.nodeAt(nextPos);
        if (nextNode?.type.name !== COLUMN_BLOCK) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        // Right to left the next column is on the left: moving left widens this one.
        const sign = inlineSign(dom);
        const px = dom.getBoundingClientRect().width;
        const pxTotal = px + next.getBoundingClientRect().width;
        const total = columnWidth(node.attrs.width) + columnWidth(nextNode.attrs.width);
        const min = Math.min(MIN_COLUMN_PX, pxTotal / 2);
        let share = columnWidth(node.attrs.width) / total;
        dom.classList.add("leafdesk-column-resizing");
        const move = (e: PointerEvent) => {
          share = Math.min(Math.max(px + (e.clientX - startX) * sign, min), pxTotal - min) / pxTotal;
          // A preview on the elements; the document changes once, when the drag ends.
          dom.style.flexGrow = String(total * share);
          next.style.flexGrow = String(total * (1 - share));
        };
        const up = () => {
          stop?.();
          const a = columnWidth(total * share);
          const b = columnWidth(total - a);
          const at = getPos();
          if (typeof at !== "number") return;
          const tr = view.state.tr;
          const own = tr.doc.nodeAt(at);
          const other = tr.doc.nodeAt(at + (own?.nodeSize ?? 0));
          if (own?.type.name !== COLUMN_BLOCK || other?.type.name !== COLUMN_BLOCK) return;
          if (own.attrs.width === a && other.attrs.width === b) return;
          tr.setNodeAttribute(at, "width", a).setNodeAttribute(at + own.nodeSize, "width", b);
          view.dispatch(tr);
        };
        stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          dom.classList.remove("leafdesk-column-resizing");
          stop = null;
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      };
      handle.addEventListener("pointerdown", onPointerDown);

      return {
        dom,
        contentDOM,
        update(next: PMNode) {
          if (next.type !== node.type) return false;
          node = next;
          sync();
          return true;
        },
        // The handle and the element's own style are ours; ProseMirror only reads the blocks.
        ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
          if (mutation.type === "selection") return false;
          return !contentDOM.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === contentDOM);
        },
        stopEvent(event: Event) {
          return event.target instanceof Node && handle.contains(event.target);
        },
        destroy() {
          stop?.();
          handle.removeEventListener("pointerdown", onPointerDown);
        },
      };
    };
  },
});

/** Room kept outside a wide column list for the block handles, in pixels (globals.css). */
const WIDE_GUTTER_PX = 48;

/**
 * A column list whose outer edges can be dragged into the page's margins (`wide`, see lib/columns).
 * Its element carries the block's attributes; the columns sit in an inner row. The handles only
 * show where the list can be wide (globals.css): a top-level list on a page of standard width.
 */
const EditorColumnListNode = ColumnListNode.extend({
  addNodeView() {
    return ({ node: initial, getPos, view, editor }) => {
      let node = initial;
      const dom = document.createElement("div");
      dom.className = "leafdesk-column-list";
      dom.setAttribute("data-node-type", COLUMN_LIST_BLOCK);
      const contentDOM = document.createElement("div");
      contentDOM.className = "leafdesk-columns";
      const handles = (["start", "end"] as const).map((side) => {
        const handle = document.createElement("div");
        handle.className = `leafdesk-columns-edge leafdesk-columns-edge-${side}`;
        handle.contentEditable = "false";
        handle.setAttribute("aria-hidden", "true");
        return handle;
      });
      dom.append(handles[0], contentDOM, handles[1]);

      const sync = () => {
        if (node.attrs.id) dom.setAttribute("data-id", String(node.attrs.id));
        const wide = columnsWide(node.attrs.wide);
        if (wide) dom.setAttribute("data-wide", String(wide));
        else dom.removeAttribute("data-wide");
        dom.style.setProperty("--wide", String(wide));
      };
      sync();

      let stop: (() => void) | null = null;
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !editor.isEditable) return;
        const handle = event.currentTarget as HTMLElement;
        const parent = dom.parentElement;
        const area = dom.closest<HTMLElement>("[data-page-area]");
        if (!parent || !area) return;
        event.preventDefault();
        event.stopPropagation();
        // How far the list may reach past the text on each side, and how far it does now.
        const text = parent.getBoundingClientRect().width;
        const room = Math.max(0, (area.getBoundingClientRect().width - text) / 2 - WIDE_GUTTER_PX);
        if (!room) return;
        const startX = event.clientX;
        // The start edge widens moving toward the start, the end edge toward the end.
        const outward = (handle.classList.contains("leafdesk-columns-edge-start") ? -1 : 1) * inlineSign(dom);
        const from = columnsWide(node.attrs.wide) * room;
        let wide = columnsWide(node.attrs.wide);
        dom.classList.add("leafdesk-columns-resizing");
        const move = (e: PointerEvent) => {
          wide = columnsWide(Math.min(Math.max(from + (e.clientX - startX) * outward, 0), room) / room);
          dom.style.setProperty("--wide", String(wide));
          dom.toggleAttribute("data-wide", wide > 0);
        };
        const up = () => {
          stop?.();
          const at = getPos();
          if (typeof at !== "number" || view.state.doc.nodeAt(at)?.type.name !== COLUMN_LIST_BLOCK) return;
          if (columnsWide(view.state.doc.nodeAt(at)?.attrs.wide) === wide) return sync();
          view.dispatch(view.state.tr.setNodeAttribute(at, "wide", wide));
        };
        stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          dom.classList.remove("leafdesk-columns-resizing");
          stop = null;
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      };
      for (const handle of handles) handle.addEventListener("pointerdown", onPointerDown);

      return {
        dom,
        contentDOM,
        update(next: PMNode) {
          if (next.type !== node.type) return false;
          node = next;
          sync();
          return true;
        },
        ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
          if (mutation.type === "selection") return false;
          return !contentDOM.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === contentDOM);
        },
        stopEvent(event: Event) {
          return event.target instanceof Node && handles.some((handle) => handle.contains(event.target as Node));
        },
        destroy() {
          stop?.();
          for (const handle of handles) handle.removeEventListener("pointerdown", onPointerDown);
        },
      };
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Cleanup

/**
 * Removing the last block of a column (dragging it away, cutting it) leaves the column holding one
 * empty line ProseMirror adds to keep the document valid, and when the list had two columns,
 * ProseMirror may drop the column and make an empty one to keep two. Either way what ProseMirror
 * made has no id yet (BlockNote gives it one right after), which tells it apart from a column
 * that is empty on purpose: a new one, or one whose only line was just cleared. Such a column
 * goes, and a column list left with one column is replaced by that column's blocks. (Removing
 * blocks through BlockNote's API, as the side menu's "Delete" does, is cleaned up by its core.)
 *
 * Changes from other people and undo/redo arrive already cleaned up by the editor they were made
 * in, so only local changes are looked at.
 */

/** The id of a column's only block, when that block is an empty line; undefined otherwise. */
function emptyLineId(column: PMNode): string | null | undefined {
  if (column.childCount !== 1) return undefined;
  const block = column.firstChild!;
  const content = block.firstChild;
  if (block.childCount !== 1 || content?.type.name !== "paragraph" || content.content.size !== 0) return undefined;
  return block.attrs.id ? String(block.attrs.id) : null;
}

/** The block ids of each column of a document. */
function columnContents(doc: PMNode) {
  const columns = new Map<string, Set<string>>();
  doc.descendants((node) => {
    if (node.isTextblock) return false;
    if (node.type.name === COLUMN_BLOCK && node.attrs.id) {
      const inside = new Set<string>();
      node.forEach((child) => void (child.attrs.id && inside.add(String(child.attrs.id))));
      columns.set(String(node.attrs.id), inside);
    }
    return true;
  });
  return columns;
}

/** Where (in the last document) the transactions left empty columns ProseMirror made, without an id. */
function madeColumns(transactions: readonly Transaction[]): Set<number> {
  const out = new Set<number>();
  transactions.forEach((tr, i) => {
    if (!tr.docChanged) return;
    tr.doc.descendants((node, pos) => {
      if (node.isTextblock) return false;
      if (node.type.name === COLUMN_BLOCK && !node.attrs.id && emptyLineId(node) !== undefined) {
        out.add(transactions.slice(i + 1).reduce((at, later) => later.mapping.map(at), pos));
      }
      return true;
    });
  });
  return out;
}

const ColumnCleanup = createExtension(() => ({
  key: "leafdeskColumnCleanup",
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey("leafdeskColumnCleanup"),
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
        // Column lists with an empty column, and those columns' places, ids and lines.
        const found: { pos: number; columns: { index: number; pos: number; id: string | null; line: string | null }[] }[] = [];
        newState.doc.descendants((node, pos) => {
          if (node.isTextblock) return false;
          if (node.type.name !== COLUMN_LIST_BLOCK) return true;
          const columns: (typeof found)[number]["columns"] = [];
          node.forEach((column, offset, index) => {
            const line = emptyLineId(column);
            if (line !== undefined) columns.push({ index, pos: pos + 1 + offset, id: column.attrs.id ? String(column.attrs.id) : null, line });
          });
          if (columns.length) found.push({ pos, columns });
          return true;
        });
        if (!found.length) return null;
        const before = columnContents(oldState.doc);
        const made = madeColumns(transactions);
        const lists = found
          .map(({ pos, columns }) => ({
            pos,
            drop: new Set(
              columns
                .filter(({ pos: at, id, line }) => {
                  if (made.has(at)) return true;
                  // A column that was there: emptied if its line is new to it (made by ProseMirror).
                  const had = id ? before.get(id) : undefined;
                  return had !== undefined && !(line && had.has(line));
                })
                .map(({ index }) => index),
            ),
          }))
          .filter(({ drop }) => drop.size);
        if (!lists.length) return null;
        const tr = newState.tr;
        // Last first; positions are mapped through the changes already made.
        for (const { pos, drop } of lists.reverse()) {
          const at = tr.mapping.map(pos);
          const list = tr.doc.nodeAt(at);
          if (list?.type.name !== COLUMN_LIST_BLOCK) continue;
          const keep: PMNode[] = [];
          const ranges: { from: number; to: number }[] = [];
          list.forEach((column, offset, index) => {
            if (drop.has(index)) ranges.push({ from: at + 1 + offset, to: at + 1 + offset + column.nodeSize });
            else keep.push(column);
          });
          if (keep.length >= 2) {
            for (const { from, to } of ranges.reverse()) tr.delete(from, to);
          } else if (keep.length === 1) {
            tr.replaceWith(at, at + list.nodeSize, keep[0].content);
          } else {
            tr.delete(at, at + list.nodeSize);
          }
        }
        return tr.docChanged ? tr : null;
      },
    }),
  ],
}));

/** The editor's column blocks: resizable columns, and the cleanup above. */
export const columnEditorBlockSpecs = columnBlockSpecs({ columnList: EditorColumnListNode, column: EditorColumnNode, extensions: [ColumnCleanup()] });

// ---------------------------------------------------------------------------------------------
// Slash menu

type AnyBlock = PageEditor["document"][number];

/** The column the block is in (at any depth), if any. */
function enclosingColumn(editor: PageEditor, block: AnyBlock): AnyBlock | undefined {
  let current: AnyBlock | undefined = block;
  while (current) {
    const parent: AnyBlock | undefined = editor.getParentBlock(current);
    if (parent?.type === COLUMN_BLOCK) return parent;
    current = parent;
  }
  return undefined;
}

const emptyLine = (block: AnyBlock) =>
  block.type === "paragraph" &&
  !block.children.length &&
  Array.isArray(block.content) &&
  (block.content.length === 0 || (block.content.length === 1 && block.content[0].type === "text" && block.content[0].text.trim() === "/"));

/**
 * "Wide columns" in the block menu of a block in a top-level column list: the list reaches out to
 * the page's edges, or back to the text's width. Its outer edges set anything between.
 */
export function WideColumnsItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blockMenu");
  if (!block || !editor.isEditable) return null;
  const column = enclosingColumn(editor, block as AnyBlock);
  const list = column && editor.getParentBlock(column);
  if (list?.type !== COLUMN_LIST_BLOCK || editor.getParentBlock(list)) return null;
  const wide = columnsWide((list.props as { wide?: unknown }).wide) > 0;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      checked={wide}
      onClick={() => {
        if (editor.getBlock(list.id)) editor.updateBlock(list.id, { props: { wide: wide ? 0 : 1 } } as never);
      }}
    >
      {t("wideColumns")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * Slash menu entries for columns, read when the menu opens: "2 columns" and "3 columns", or inside
 * a column (columns don't nest) "Add column" while its list has fewer than five.
 */
export function useColumnSlashItems(editor: PageEditor): () => DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks.columns");
  return useCallback(() => {
    const group = editor.dictionary.slash_menu.table.group;
    const block = editor.getTextCursorPosition().block;
    const item = (key: "two" | "three" | "add", icon: React.JSX.Element, onItemClick: () => void): DefaultReactSuggestionItem => ({
      title: t(`${key}.title`),
      subtext: t(`${key}.subtext`),
      aliases: t(`${key}.aliases`).split(" "),
      group,
      icon,
      onItemClick,
    });
    const column = enclosingColumn(editor, block);
    if (column) {
      const list = editor.getParentBlock(column);
      if (!list || list.children.length >= MAX_COLUMNS) return [];
      return [
        item("add", <BetweenVerticalStart size={18} />, () => {
          const current = editor.getTextCursorPosition().block;
          editor.transact((tr) => {
            // The line the menu was opened on goes, unless it is all the column has.
            if (emptyLine(current) && column.children.length > 1) {
              tr.doc.descendants((node, pos) => {
                if (node.attrs.id !== current.id || node.type.name !== "blockContainer") return true;
                tr.delete(pos, pos + node.nodeSize);
                return false;
              });
            }
            const [added] = editor.insertBlocks([{ type: COLUMN_BLOCK, children: [{ type: "paragraph" }] }], column, "after");
            if (added?.children[0]) editor.setTextCursorPosition(added.children[0], "start");
          });
        }),
      ];
    }
    const insert = (count: number) => () => {
      const current = editor.getTextCursorPosition().block;
      const list = { type: COLUMN_LIST_BLOCK, children: Array.from({ length: count }, () => ({ type: COLUMN_BLOCK, children: [{ type: "paragraph" }] })) };
      editor.transact(() => {
        const [placed] = emptyLine(current)
          ? editor.replaceBlocks([current], [list] as never).insertedBlocks
          : editor.insertBlocks([list] as never, current, "after");
        const first = placed?.children[0]?.children[0];
        if (first) editor.setTextCursorPosition(first, "start");
      });
    };
    return [item("two", <Columns2 size={18} />, insert(2)), item("three", <Columns3 size={18} />, insert(3))];
  }, [editor, t]);
}

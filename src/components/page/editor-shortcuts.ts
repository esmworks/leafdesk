"use client";

import { createExtension } from "@blocknote/core";
import { copyText } from "@/components/settings/copy-button";
import { blockPath } from "@/lib/mentions";
import { CODE_LANGUAGE_COMBO, COPY_BLOCK_LINK_COMBO, STRIKE_COMBO } from "@/lib/shortcuts";

/**
 * The page editor's keys besides BlockNote's (lib/shortcuts lists them for the shortcuts dialog):
 * Mod+Shift+X for strikethrough (as well as BlockNote's Mod+Shift+S), and Alt+Shift+L to copy a
 * link to the block the cursor is in, the same link as "Copy link to block" in the block menu, and
 * Mod+Alt+L in a code block to pick its language from the keyboard (code-block.tsx's menu).
 */

/** Sent when a link to a block or a thread was copied; the editor shows "Link copied" (LinkCopiedNotice). */
export const BLOCK_LINK_COPIED_EVENT = "leafdesk:block-link-copied";

/** Copies an address of the app (`path`) and says so ("Link copied", LinkCopiedNotice). */
export async function copyAppLink(path: string, returnFocus: HTMLElement) {
  const url = new URL(path, window.location.origin).href;
  if (await copyText(url, returnFocus)) window.dispatchEvent(new Event(BLOCK_LINK_COPIED_EVENT));
}

/** Copies the address of the page at `blockId` (block-focus.ts scrolls to it) and says so. */
export const copyBlockLink = (workspaceId: string, pageId: string, blockId: string, returnFocus: HTMLElement) =>
  copyAppLink(blockPath(workspaceId, pageId, blockId), returnFocus);

/** ProseMirror's name for a combination: "Mod-Shift-x". Letters lower case, since Shift is named. */
export const keyName = (combo: readonly string[]) => combo.map((key) => (key.length === 1 ? key.toLowerCase() : key)).join("-");

/**
 * The extension, with where the page is: read when a key is pressed, so the editor isn't made
 * again when it changes. ProseMirror matches Alt+Shift+L by the key's place when Option makes it
 * another character ("Ò" on a Mac).
 */
export const editorShortcuts = (where: () => { workspaceId: string; pageId: string } | null) =>
  createExtension({
    key: "leafdeskShortcuts",
    keyboardShortcuts: {
      [keyName(STRIKE_COMBO)]: ({ editor }) => {
        if (!editor.isEditable) return false;
        editor.toggleStyles({ strike: true } as never);
        return true;
      },
      [keyName(CODE_LANGUAGE_COMBO)]: ({ editor }) => {
        const block = editor.getTextCursorPosition().block;
        if (!editor.isEditable || block?.type !== "codeBlock") return false;
        const menu = editor.domElement?.querySelector<HTMLSelectElement>(`select[data-code-language="${CSS.escape(block.id)}"]`);
        if (!menu) return false;
        menu.focus();
        // Opens the list where the browser can; elsewhere the focused menu takes arrow keys and typing.
        try {
          menu.showPicker();
        } catch {}
        return true;
      },
      [keyName(COPY_BLOCK_LINK_COMBO)]: ({ editor }) => {
        const page = where();
        const block = editor.getTextCursorPosition().block;
        if (!page || !block) return false;
        void copyBlockLink(page.workspaceId, page.pageId, block.id, editor.domElement ?? document.body);
        return true;
      },
    },
  });

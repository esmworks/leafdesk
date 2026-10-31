/**
 * Leafdesk's keyboard shortcuts, as the shortcuts dialog (components/shortcuts-dialog.tsx) lists
 * them. Only keys something actually handles belong here: the app's own (the handlers named on
 * each group) and the editor's that BlockNote and its marks bind (lib/text-scripts for
 * superscript and subscript, written out here so the sidebar doesn't load the editor; a test
 * checks they match). Descriptions are messages `shortcuts.items.<id>`.
 *
 * A shortcut is one or more alternative combinations; a combination is its keys in order, with
 * "Mod" for ⌘ on Apple devices and Ctrl elsewhere.
 */

import { detectPlatform, matchesKeyboardEvent, type HotkeyChord } from "@tanstack/hotkeys";

type Texts = typeof import("@/i18n/messages/en/shortcuts.json");

export type Combo = readonly string[];
/** `sequence`: its keys are pressed one after the other (g then i), not held together. */
export type Shortcut = { id: keyof Texts["items"]; combos: readonly Combo[]; sequence?: boolean };
export type ShortcutGroup = { id: keyof Texts["groups"]; shortcuts: readonly Shortcut[] };

/** What a table row's menu does from the keyboard while it is open (see rowMenuShortcut). */
export const ROW_MENU_COMBOS = {
  duplicate: ["Mod", "D"],
  moveTo: ["Mod", "Shift", "P"],
  comment: ["Mod", "Shift", "M"],
  trash: ["Del"],
} as const satisfies Record<string, Combo>;

/**
 * The editor's own keys besides BlockNote's (components/page/editor-shortcuts.ts binds them, in
 * ProseMirror's notation: these joined with "-"). Strikethrough has BlockNote's Mod+Shift+S too.
 */
export const STRIKE_COMBO = ["Mod", "Shift", "X"] as const satisfies Combo;
export const COPY_BLOCK_LINK_COMBO = ["Alt", "Shift", "L"] as const satisfies Combo;
/** Opens the language menu of the code block the cursor is in (components/page/editor-shortcuts.ts). */
export const CODE_LANGUAGE_COMBO = ["Mod", "Alt", "L"] as const satisfies Combo;
/** Opens or closes every toggle and group on the page (see opensToggleAll). */
export const TOGGLE_ALL_COMBO = ["Mod", "Alt", "T"] as const satisfies Combo;
/**
 * In a table's selected cells: fills each column down from the range's top cell, or with the
 * cells of one row selected duplicates that row (see cellGridShortcut).
 */
export const FILL_DOWN_COMBO = ["Mod", "D"] as const satisfies Combo;
/** Saves the page as a version, asking for an optional name first (see savesVersion). */
export const SAVE_VERSION_COMBO = ["Mod", "S"] as const satisfies Combo;
/** Starts and finishes dictating at the caret (lib/dictation pressesDictate, components/page/dictation.tsx). */
export const DICTATE_COMBO = ["Mod", "Shift", "D"] as const satisfies Combo;

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "general",
    shortcuts: [
      // This dialog (components/sidebar/sidebar.tsx).
      { id: "shortcuts", combos: [["Mod", "/"], ["?"]] },
      // Dialogs, menus and panels (components/ui.tsx useDismiss, the comments and AI panels).
      { id: "close", combos: [["Esc"]] },
      // components/page/page-view.tsx; the keys inside it are presentation.tsx's.
      { id: "present", combos: [["Mod", "Alt", "P"]] },
      // components/toggle-all.ts, on pages and databases: toggles and grouped views' groups.
      { id: "toggleAll", combos: [TOGGLE_ALL_COMBO] },
      // components/page/page-view.tsx and history-panel.tsx, on pages the person can edit.
      { id: "saveVersion", combos: [SAVE_VERSION_COMBO] },
      // components/sidebar/sidebar-context.tsx, in a workspace.
      { id: "theme", combos: [["Mod", "Shift", "L"]] },
    ],
  },
  {
    id: "navigation",
    shortcuts: [
      // components/sidebar/sidebar.tsx and sidebar-context.tsx.
      { id: "search", combos: [["Mod", "K"], ["Mod", "P"]] },
      { id: "sidebar", combos: [["Mod", "\\"]] },
      // components/page/find-bar.tsx.
      { id: "find", combos: [["Mod", "F"]] },
      { id: "findNext", combos: [["Mod", "G"], ["Enter"]] },
      { id: "findPrevious", combos: [["Mod", "Shift", "G"], ["Shift", "Enter"]] },
      { id: "replaceAll", combos: [["Mod", "Enter"]] },
    ],
  },
  {
    id: "text",
    shortcuts: [
      // The editor's marks (BlockNote's, from tiptap).
      { id: "bold", combos: [["Mod", "B"]] },
      { id: "italic", combos: [["Mod", "I"]] },
      { id: "underline", combos: [["Mod", "U"]] },
      { id: "strike", combos: [["Mod", "Shift", "S"], STRIKE_COMBO] },
      { id: "code", combos: [["Mod", "E"]] },
      { id: "superscript", combos: [["Mod", "."]] },
      { id: "subscript", combos: [["Mod", ","]] },
      // BlockNote's link box, with text selected (the sidebar's Mod+K leaves it alone then).
      { id: "link", combos: [["Mod", "K"]] },
    ],
  },
  {
    id: "blocks",
    shortcuts: [
      // The slash menu (components/page/collab-editor.tsx) and mentions (mentions.tsx).
      { id: "slashMenu", combos: [["/"]] },
      { id: "mention", combos: [["@"]] },
      { id: "pageLink", combos: [["[["]] },
      { id: "newSubPage", combos: [["+"]] },
      // BlockNote's block shortcuts.
      { id: "paragraph", combos: [["Mod", "Alt", "0"]] },
      { id: "heading1", combos: [["Mod", "Alt", "1"]] },
      { id: "heading2", combos: [["Mod", "Alt", "2"]] },
      { id: "heading3", combos: [["Mod", "Alt", "3"]] },
      { id: "bulletList", combos: [["Mod", "Shift", "8"]] },
      { id: "numberedList", combos: [["Mod", "Shift", "7"]] },
      { id: "checklist", combos: [["Mod", "Shift", "9"]] },
      { id: "toggleList", combos: [["Mod", "Shift", "6"]] },
      { id: "quote", combos: [["Mod", "Alt", "Q"], [">"], ["|"], ['"']] },
      { id: "indent", combos: [["Tab"]] },
      { id: "outdent", combos: [["Shift", "Tab"]] },
      { id: "moveUp", combos: [["Mod", "Shift", "ArrowUp"]] },
      { id: "moveDown", combos: [["Mod", "Shift", "ArrowDown"]] },
      // components/page/editor-shortcuts.ts.
      { id: "copyBlockLink", combos: [COPY_BLOCK_LINK_COMBO] },
      { id: "codeLanguage", combos: [CODE_LANGUAGE_COMBO] },
      // components/page/dictation.tsx, where the workspace can transcribe.
      { id: "dictate", combos: [DICTATE_COMBO] },
      { id: "undo", combos: [["Mod", "Z"]] },
      { id: "redo", combos: [["Mod", "Shift", "Z"], ["Mod", "Y"]] },
    ],
  },
  {
    id: "databases",
    shortcuts: [
      // A focused card or row of a list, gallery, calendar or timeline.
      { id: "openRow", combos: [["Enter"]] },
      // The row panel beside a view (components/database/row-panel.tsx), outside text fields.
      { id: "previousRow", combos: [["K"]] },
      { id: "nextRow", combos: [["J"]] },
      // components/database/timeline-view.tsx.
      { id: "moveBar", combos: [["Alt", "ArrowLeft"], ["Alt", "ArrowRight"]] },
      // components/database/formula-editor.tsx and ai-autofill.tsx.
      { id: "saveFormula", combos: [["Mod", "Enter"]] },
      // components/database/bulk-actions.tsx.
      { id: "clearSelection", combos: [["Esc"]] },
      // The selected cells of a table (components/database/use-cell-grid.ts).
      { id: "fillDown", combos: [FILL_DOWN_COMBO] },
      // A table row's menu, while it is open (components/database/row-menu.tsx).
      { id: "rowDuplicate", combos: [ROW_MENU_COMBOS.duplicate] },
      { id: "rowMoveTo", combos: [ROW_MENU_COMBOS.moveTo] },
      { id: "rowComment", combos: [ROW_MENU_COMBOS.comment] },
      { id: "rowTrash", combos: [ROW_MENU_COMBOS.trash] },
    ],
  },
  {
    id: "mail",
    shortcuts: [
      // The Mail tab (components/mail/mail-app.tsx), outside text fields; the composer's Mod+Enter.
      { id: "mailCompose", combos: [["C"]] },
      { id: "mailSearch", combos: [["/"]] },
      { id: "mailNext", combos: [["J"]] },
      { id: "mailPrevious", combos: [["K"]] },
      { id: "mailOpen", combos: [["Enter"], ["O"]] },
      { id: "mailBack", combos: [["Esc"]] },
      { id: "mailSelect", combos: [["X"]] },
      { id: "mailSelectAll", combos: [["Mod", "A"]] },
      { id: "mailArchive", combos: [["E"]] },
      { id: "mailTrash", combos: [["#"]] },
      { id: "mailJunk", combos: [["!"]] },
      { id: "mailStar", combos: [["S"]] },
      { id: "mailUnread", combos: [["U"]] },
      { id: "mailRead", combos: [["Shift", "I"]] },
      { id: "mailUndo", combos: [["Mod", "Z"]] },
      { id: "mailReply", combos: [["R"]] },
      { id: "mailReplyAll", combos: [["A"]] },
      { id: "mailForward", combos: [["F"]] },
      { id: "mailSend", combos: [["Mod", "Enter"]] },
      { id: "mailGoInbox", combos: [["G", "I"]], sequence: true },
      { id: "mailGoSent", combos: [["G", "S"]], sequence: true },
      { id: "mailGoDrafts", combos: [["G", "D"]], sequence: true },
      { id: "mailGoArchive", combos: [["G", "A"]], sequence: true },
      { id: "mailGoTrash", combos: [["G", "T"]], sequence: true },
    ],
  },
];

/** Apple devices, where Mod is ⌘ and modifiers show as symbols. */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const MAC_KEYS: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Ctrl: "⌃" };
const OTHER_KEYS: Record<string, string> = { Mod: "Ctrl" };
const ARROWS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** The labels of a combination's keys, one per key cap: ⌘ ⇧ Z on a Mac, Ctrl Shift Z elsewhere. */
export function keyLabels(combo: Combo, mac: boolean): string[] {
  return combo.map((key) => (mac ? MAC_KEYS[key] : OTHER_KEYS[key]) ?? ARROWS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}

/** A combination as one string, for tooltips and menus: "⌘/" on a Mac, "Ctrl+/" elsewhere. */
export function comboText(combo: Combo, mac: boolean): string {
  return keyLabels(combo, mac).join(mac ? "" : "+");
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing"> & {
  target: EventTarget | null;
  getModifierState?: (key: string) => boolean;
};

/**
 * Whether a key press is a combination such as "Mod+Alt+T", through TanStack Hotkeys' matcher: by
 * the letter the layout types (Ctrl+S on a Turkish F keyboard is the key labelled S, wherever it
 * sits), by the key's place when the modifiers type something else (Option+T is "†" on a Mac,
 * Ctrl+S is "ы" on a Russian keyboard), and never while AltGr types a character (AltGr+T is "₺"
 * on a Turkish Q keyboard, reported as Ctrl+Alt+T on Windows).
 */
function pressed(e: KeyEventLike, combo: string, mac: boolean): boolean {
  const platform = mac ? "mac" : detectPlatform() === "linux" ? "linux" : "windows";
  return matchesKeyboardEvent(e as KeyboardEvent, combo as HotkeyChord, platform);
}

/** Text fields and the editor, where "?" is typed rather than a shortcut. */
export function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  return element.isContentEditable || element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/**
 * Whether a key press opens the shortcuts dialog: Mod+/ anywhere, "?" outside text fields and the
 * editor. Not when something handled the key already (on keyboards where "/" takes Shift, the
 * editor's Mod+Shift+7 is that key) or while composing text.
 */
export function opensShortcuts(e: KeyEventLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing || e.altKey) return false;
  if (e.key === "/") return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key === "?" && !e.metaKey && !e.ctrlKey && !isEditable(e.target);
}

/** Whether a key press presents the page: Mod+Alt+P (see pressed for which keys count). */
export function opensPresentation(e: KeyEventLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  return pressed(e, "Mod+Alt+P", mac);
}

/**
 * Whether a key press saves the page as a version: Mod+S (SAVE_VERSION_COMBO). Not with Shift
 * (Mod+Shift+S strikes text through) or Alt.
 */
export function savesVersion(e: KeyEventLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  return pressed(e, SAVE_VERSION_COMBO.join("+"), mac);
}

/**
 * Which of a table row's menu actions a key press asks for (ROW_MENU_COMBOS); Del only outside a
 * field with text in it.
 */
export function rowMenuShortcut(e: KeyEventLike, mac: boolean): keyof typeof ROW_MENU_COMBOS | null {
  if (e.defaultPrevented || e.isComposing || e.altKey) return null;
  if (e.key === "Delete" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    const field = e.target as HTMLInputElement | null;
    return isEditable(field) && field?.value ? null : "trash";
  }
  if (pressed(e, ROW_MENU_COMBOS.duplicate.join("+"), mac)) return "duplicate";
  if (pressed(e, ROW_MENU_COMBOS.moveTo.join("+"), mac)) return "moveTo";
  if (pressed(e, ROW_MENU_COMBOS.comment.join("+"), mac)) return "comment";
  return null;
}

/** Whether a key press opens or closes every toggle and group: Mod+Alt+T (TOGGLE_ALL_COMBO). */
export function opensToggleAll(e: KeyEventLike, mac: boolean): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  return pressed(e, TOGGLE_ALL_COMBO.join("+"), mac);
}

/**
 * Which of the table grid's actions a key press asks for: "fillDown" for Mod+D (FILL_DOWN_COMBO).
 * What it does depends on the selection: see components/database/use-cell-grid.ts.
 */
export function cellGridShortcut(e: KeyEventLike, mac: boolean): "fillDown" | null {
  if (e.defaultPrevented || e.isComposing) return null;
  return pressed(e, FILL_DOWN_COMBO.join("+"), mac) ? "fillDown" : null;
}

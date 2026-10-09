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

type Texts = typeof import("@/i18n/messages/en/shortcuts.json");

export type Combo = readonly string[];
export type Shortcut = { id: keyof Texts["items"]; combos: readonly Combo[] };
export type ShortcutGroup = { id: keyof Texts["groups"]; shortcuts: readonly Shortcut[] };

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "general",
    shortcuts: [
      // This dialog (components/sidebar/sidebar.tsx).
      { id: "shortcuts", combos: [["Mod", "/"], ["?"]] },
      // Dialogs, menus and panels (components/ui.tsx useDismiss, the comments and AI panels).
      { id: "close", combos: [["Esc"]] },
    ],
  },
  {
    id: "navigation",
    shortcuts: [
      // components/sidebar/sidebar.tsx and sidebar-context.tsx.
      { id: "search", combos: [["Mod", "K"]] },
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
      { id: "strike", combos: [["Mod", "Shift", "S"]] },
      { id: "code", combos: [["Mod", "E"]] },
      { id: "superscript", combos: [["Mod", "."]] },
      { id: "subscript", combos: [["Mod", ","]] },
    ],
  },
  {
    id: "blocks",
    shortcuts: [
      // The slash menu (components/page/collab-editor.tsx) and mentions (mentions.tsx).
      { id: "slashMenu", combos: [["/"]] },
      { id: "mention", combos: [["@"]] },
      { id: "pageLink", combos: [["[["]] },
      // BlockNote's block shortcuts.
      { id: "paragraph", combos: [["Mod", "Alt", "0"]] },
      { id: "heading1", combos: [["Mod", "Alt", "1"]] },
      { id: "heading2", combos: [["Mod", "Alt", "2"]] },
      { id: "heading3", combos: [["Mod", "Alt", "3"]] },
      { id: "bulletList", combos: [["Mod", "Shift", "8"]] },
      { id: "numberedList", combos: [["Mod", "Shift", "7"]] },
      { id: "checklist", combos: [["Mod", "Shift", "9"]] },
      { id: "toggleList", combos: [["Mod", "Shift", "6"]] },
      { id: "quote", combos: [["Mod", "Alt", "Q"]] },
      { id: "indent", combos: [["Tab"]] },
      { id: "outdent", combos: [["Shift", "Tab"]] },
      { id: "moveUp", combos: [["Mod", "Shift", "ArrowUp"]] },
      { id: "moveDown", combos: [["Mod", "Shift", "ArrowDown"]] },
      { id: "undo", combos: [["Mod", "Z"]] },
      { id: "redo", combos: [["Mod", "Shift", "Z"], ["Mod", "Y"]] },
    ],
  },
  {
    id: "databases",
    shortcuts: [
      // A focused card or row of a list, gallery, calendar or timeline.
      { id: "openRow", combos: [["Enter"]] },
      // components/database/timeline-view.tsx.
      { id: "moveBar", combos: [["Alt", "ArrowLeft"], ["Alt", "ArrowRight"]] },
      // components/database/formula-editor.tsx and ai-autofill.tsx.
      { id: "saveFormula", combos: [["Mod", "Enter"]] },
      // components/database/bulk-actions.tsx.
      { id: "clearSelection", combos: [["Esc"]] },
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

type KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing"> & {
  target: EventTarget | null;
};

/** Text fields and the editor, where "?" is typed rather than a shortcut. */
function isEditable(target: EventTarget | null): boolean {
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

/**
 * The character a key press types into a table's active cell, which opens the cell's editor
 * starting with it; null for keys that don't type (arrows, shortcuts, Space, which opens the
 * editor as it is, and keys an input method is still composing).
 */
export function typedCharacter(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }): string | null {
  if (e.isComposing || e.metaKey || e.key === " " || [...e.key].length !== 1) return null;
  // Ctrl alone is a shortcut. Ctrl with Alt is AltGr on Windows, which types (@, €, ₺), and Option
  // alone types on a Mac; with a plain letter or digit either is a shortcut instead.
  if (e.ctrlKey && !e.altKey) return null;
  if ((e.ctrlKey || e.altKey) && /^[a-z0-9]$/i.test(e.key)) return null;
  return e.key;
}

/** The event a table dispatches on a cell's editor opener (`data-cell-open="text"`) to open it with `detail` typed. */
export const CELL_TYPE_EVENT = "leafdesk:cell-type";

/**
 * The global shortcut: from any app, it brings Leafdesk forward on its AI chat (the server's `/ai`
 * sends a workspace without AI to a quick note instead). The person picks one of a few shortcuts in
 * the menu, or none; main.ts registers it with the system.
 */

/** "off": no shortcut. */
export const SHORTCUT_OFF = "off";

/** The shortcuts the menu offers, in Electron's accelerator form; the first is the default. */
export function shortcutChoices(platform: NodeJS.Platform): string[] {
  const mod = platform === "darwin" ? "Command" : "Control";
  const alt = platform === "darwin" ? "Option" : "Alt";
  return [`${mod}+Shift+J`, `${mod}+Shift+Space`, `${mod}+${alt}+L`];
}

export function defaultShortcut(platform: NodeJS.Platform) {
  return shortcutChoices(platform)[0];
}

/** A stored setting, kept only if it is one of the choices or "off"; anything else is the default (unset). */
export function readShortcut(value: unknown, platform: NodeJS.Platform): string | undefined {
  if (value === SHORTCUT_OFF) return SHORTCUT_OFF;
  return typeof value === "string" && shortcutChoices(platform).includes(value) ? value : undefined;
}

/** The accelerator to register for a setting, or null when it is off. */
export function activeShortcut(setting: string | undefined, platform: NodeJS.Platform): string | null {
  if (setting === SHORTCUT_OFF) return null;
  return readShortcut(setting, platform) ?? defaultShortcut(platform);
}

const MAC_SYMBOLS: Record<string, string> = { Control: "⌃", Option: "⌥", Alt: "⌥", Shift: "⇧", Command: "⌘" };
const MAC_ORDER = ["Control", "Option", "Alt", "Shift", "Command"];

/**
 * How the menu shows a shortcut: macOS's symbols in its order (⇧⌘J), elsewhere the keys' names
 * (Ctrl+Shift+J). Shown as the item's label, not its accelerator, so the menu doesn't take the keys.
 */
export function shortcutLabel(accelerator: string, platform: NodeJS.Platform) {
  const keys = accelerator.split("+");
  const key = keys.pop() ?? "";
  if (platform !== "darwin") return [...keys.map((name) => (name === "Control" ? "Ctrl" : name)), key].join("+");
  const modifiers = keys.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).map((name) => MAC_SYMBOLS[name] ?? name);
  return `${modifiers.join("")}${key}`;
}

/** The workspace a page of the server's is in (`/w/<id>/…`), if it is one. */
export function workspaceIn(url: string, origin: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== origin) return undefined;
  const match = /^\/w\/([^/]+)/.exec(parsed.pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** The server's address for AI chat (or the quick note), in the given workspace or the person's first. */
export function aiChatPath(workspace?: string) {
  return workspace ? `/ai?${new URLSearchParams({ workspace })}` : "/ai";
}

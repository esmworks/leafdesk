/**
 * An icon field (pages, rows, callouts, buttons, callout styles, teamspaces, agents, database views
 * and properties) holds either an emoji, stored as it is, or one of the built-in line icons:
 *
 *   icon:<name>           drawn in the text color around it
 *   icon:<name>:<color>   drawn in one of ICON_COLORS
 *
 * where <name> is in lib/builtin-icon-names.ts. Small on purpose: every page's first load reads it
 * (PageIcon); the names and drawings load only where they are needed.
 */

export const BUILTIN_ICON_PREFIX = "icon:";

/** The colors a built-in icon can take besides the text color: the option palette's hues. */
export const ICON_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type IconColor = (typeof ICON_COLORS)[number];

export type BuiltinIcon = { name: string; color: IconColor | null };

/** The built-in icon `value` names, or null for an emoji, nothing, or a malformed value. The name isn't checked against the set. */
export function readBuiltinIcon(value: string | null | undefined): BuiltinIcon | null {
  if (!value?.startsWith(BUILTIN_ICON_PREFIX)) return null;
  const [name, color, ...rest] = value.slice(BUILTIN_ICON_PREFIX.length).split(":");
  if (rest.length || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name ?? "")) return null;
  if (color === undefined) return { name, color: null };
  return (ICON_COLORS as readonly string[]).includes(color) ? { name, color: color as IconColor } : null;
}

export function formatBuiltinIcon(name: string, color: IconColor | null): string {
  return `${BUILTIN_ICON_PREFIX}${name}${color ? `:${color}` : ""}`;
}

export function isBuiltinIcon(value: string | null | undefined): boolean {
  return !!value?.startsWith(BUILTIN_ICON_PREFIX);
}

/**
 * The icon as text, for places that can only show text (a select's options, a document title, a
 * Markdown heading): an emoji as it is, a built-in icon as nothing.
 */
export function iconText(value: string | null | undefined): string {
  return !value || isBuiltinIcon(value) ? "" : value;
}

/** The icon's text and a space, to put before a name where only text can show (a select's options); "" for none. */
export function iconPrefix(value: string | null | undefined): string {
  const icon = iconText(value);
  return icon ? `${icon} ` : "";
}

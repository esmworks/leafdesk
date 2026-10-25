import { isBuiltinIconName } from "./builtin-icon-names";
import { formatBuiltinIcon, ICON_COLORS, isBuiltinIcon, readBuiltinIcon } from "./icon-value";

/**
 * Pages, rows, teamspaces, agents, views and properties take an emoji (stored as it is) or a built-in
 * icon (lib/icon-value). Allowing a few code points covers modifiers and joined emoji (a family is seven).
 */
export const MAX_ICON_CODE_POINTS = 8;

/**
 * The icon to store (trimmed), or null when `value` isn't one: empty, too long, not text, or a
 * built-in icon with a name or color there isn't.
 */
export function parseIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (isBuiltinIcon(icon)) {
    const builtin = readBuiltinIcon(icon);
    return builtin && isBuiltinIconName(builtin.name) ? formatBuiltinIcon(builtin.name, builtin.color) : null;
  }
  return icon && [...icon].length <= MAX_ICON_CODE_POINTS ? icon : null;
}

/** What an icon may be, for error messages. */
export const ICON_RULE = `an emoji, or a built-in icon written "icon:<name>" or "icon:<name>:<color>" (color: ${ICON_COLORS.join(", ")})`;

/** An icon input's description in MCP and REST tools: short, every tool list carries it. */
export const ICON_INPUT = 'An emoji or "icon:<name>[:<color>]".';

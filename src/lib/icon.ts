/**
 * Pages, teamspaces and agents take an emoji as their icon (the icon picker's), stored as it is.
 * Allowing a few code points covers modifiers and joined emoji (a family is seven).
 */
export const MAX_ICON_CODE_POINTS = 8;

/** The icon to store (trimmed), or null when `value` isn't one: empty, too long, or not text. */
export function parseIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  return icon && [...icon].length <= MAX_ICON_CODE_POINTS ? icon : null;
}

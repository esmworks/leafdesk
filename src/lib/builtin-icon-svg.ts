import { BUILTIN_ICONS } from "./builtin-icons-data";
import { readBuiltinIcon, type IconColor } from "./icon-value";

/**
 * The icon colors on a light page (the stylesheet's `--icon-*`), for drawings made outside the
 * stylesheet: PDFs, favicons and exported HTML.
 */
export const ICON_COLOR_HEX: Record<IconColor, string> = {
  gray: "#5c6e61",
  brown: "#935839",
  orange: "#9c5301",
  yellow: "#7f6606",
  green: "#187d42",
  blue: "#0b6fa7",
  purple: "#7955a0",
  pink: "#9d4673",
  red: "#ac3f42",
};

const escape = (value: string | number) => String(value).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A built-in icon as a standalone SVG document, in its color (or `fallbackColor`), or null when
 * `value` isn't a built-in icon there is.
 */
export function builtinIconSvg(value: string | null | undefined, { size = 24, fallbackColor = "#1f2023" } = {}): string | null {
  const icon = readBuiltinIcon(value);
  const node = icon && BUILTIN_ICONS[icon.name];
  if (!icon || !node) return null;
  const color = icon.color ? ICON_COLOR_HEX[icon.color] : fallbackColor;
  const body = node
    .map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join("")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

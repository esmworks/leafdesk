import { ALERT_KINDS, CALLOUT_BLOCK, DEFAULT_CALLOUT_ICON } from "./content-blocks";
import { BLOCK_COLORS, type BlockColor } from "./block-colors";
import { parseIcon } from "./icon";

/**
 * Callout styles: named box looks a workspace's owners define in Settings > General (kept in the
 * workspace's settings, see WorkspaceSettings.calloutStyles), which everyone inserts like a block.
 * A styled callout stores only the style's key (`styleKey`): its icon, color, border and default
 * title come from the workspace's style wherever the page is drawn (the editor, published pages,
 * the print view), so changing a style changes every callout using it. A key no style has (one
 * deleted, or written in Markdown from elsewhere) draws as a plain callout with its own props.
 *
 * There is no CSS of anyone's own: a style picks from the editor's colors and three borders.
 * Pure and client-safe.
 */

export const CALLOUT_BORDERS = ["none", "left", "full"] as const;
export type CalloutBorder = (typeof CALLOUT_BORDERS)[number];

export type CalloutStyle = {
  /** What Markdown names it (`> [!key]`) and callouts store: a lowercase slug, unique in the workspace. */
  key: string;
  /** What the slash menu and pickers call it. */
  name: string;
  /** An emoji, or "" for none. */
  icon: string;
  color: BlockColor;
  border: CalloutBorder;
  /** The title callouts of the style show when they have none of their own; "" for none. */
  title: string;
};

export const MAX_CALLOUT_STYLES = 30;
export const MAX_CALLOUT_KEY = 32;
export const MAX_CALLOUT_NAME = 60;
export const MAX_CALLOUT_TITLE = 120;

const KEY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Built-in styles every workspace has: a framed box (`:::frame`, `:::card`, `:::panel` in
 * Markdown read as one). Their names come from the interface language.
 */
export const BUILTIN_CALLOUT_STYLES: readonly CalloutStyle[] = [
  { key: "frame", name: "Frame", icon: "", color: "default", border: "full", title: "" },
];

/**
 * Keys a workspace's style can't take: the alert kinds (`> [!NOTE]` keeps its meaning), the
 * container names Markdown import reads on its own (`:::info` …) and the built-in styles.
 */
export const RESERVED_CALLOUT_KEYS: ReadonlySet<string> = new Set([
  ...ALERT_KINDS.map((kind) => kind.toLowerCase()),
  "info",
  "danger",
  "details",
  "card",
  "panel",
  ...BUILTIN_CALLOUT_STYLES.map((style) => style.key),
]);

/** A key as callouts and Markdown write it, or null when it can't be one. */
export function calloutKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return key.length <= MAX_CALLOUT_KEY && KEY.test(key) ? key : null;
}

/** A title as a callout stores it: one line, trimmed, at most MAX_CALLOUT_TITLE characters. */
export function calloutTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/\s+/g, " ").trim()].slice(0, MAX_CALLOUT_TITLE).join("");
}

export type CalloutStyleProblem = "tooMany" | "key" | "reservedKey" | "duplicateKey" | "name" | "icon" | "color" | "border" | "title";

/**
 * The styles an owner saves, checked: `index` is the first style with a problem (-1 for the list).
 * Names and titles are trimmed; an icon must be one emoji (or nothing).
 */
export function parseCalloutStyles(
  value: unknown,
): { ok: true; styles: CalloutStyle[] } | { ok: false; problem: CalloutStyleProblem; index: number } {
  if (!Array.isArray(value)) return { ok: false, problem: "tooMany", index: -1 };
  if (value.length > MAX_CALLOUT_STYLES) return { ok: false, problem: "tooMany", index: -1 };
  const styles: CalloutStyle[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const fail = (problem: CalloutStyleProblem) => ({ ok: false as const, problem, index });
    if (!raw || typeof raw !== "object") return fail("key");
    const item = raw as Record<string, unknown>;
    const key = calloutKey(item.key);
    if (!key || item.key !== key) return fail("key");
    if (RESERVED_CALLOUT_KEYS.has(key)) return fail("reservedKey");
    if (keys.has(key)) return fail("duplicateKey");
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "";
    if (!name || [...name].length > MAX_CALLOUT_NAME) return fail("name");
    const icon = item.icon === "" || item.icon === undefined ? "" : parseIcon(item.icon);
    if (icon === null) return fail("icon");
    if (!(BLOCK_COLORS as readonly unknown[]).includes(item.color)) return fail("color");
    if (!(CALLOUT_BORDERS as readonly unknown[]).includes(item.border)) return fail("border");
    if (item.title !== undefined && typeof item.title !== "string") return fail("title");
    if (typeof item.title === "string" && [...item.title.trim()].length > MAX_CALLOUT_TITLE) return fail("title");
    keys.add(key);
    styles.push({ key, name, icon, color: item.color as BlockColor, border: item.border as CalloutBorder, title: calloutTitle(item.title) });
  }
  return { ok: true, styles };
}

/** The workspace's styles as stored, leaving out anything that wouldn't pass parseCalloutStyles. */
export function storedCalloutStyles(value: unknown): CalloutStyle[] {
  if (!Array.isArray(value)) return [];
  const out: CalloutStyle[] = [];
  for (const item of value.slice(0, MAX_CALLOUT_STYLES)) {
    const parsed = parseCalloutStyles([item]);
    if (parsed.ok && !out.some((style) => style.key === parsed.styles[0].key)) out.push(parsed.styles[0]);
  }
  return out;
}

/** The style a callout's key names: the workspace's, then the built-in ones. */
export function findCalloutStyle(styleKey: unknown, styles: readonly CalloutStyle[]): CalloutStyle | undefined {
  if (typeof styleKey !== "string" || !styleKey) return undefined;
  return styles.find((style) => style.key === styleKey) ?? BUILTIN_CALLOUT_STYLES.find((style) => style.key === styleKey);
}

/** How a callout is drawn: its style's look when its key names one, its own props otherwise. */
export type ResolvedCallout = { style: CalloutStyle | undefined; icon: string; color: string; border: CalloutBorder; title: string };

export function resolveCallout(props: Record<string, unknown> | undefined, styles: readonly CalloutStyle[]): ResolvedCallout {
  const own = {
    icon: typeof props?.icon === "string" ? props.icon : "",
    color: typeof props?.backgroundColor === "string" ? props.backgroundColor : "default",
    title: typeof props?.title === "string" ? props.title : "",
  };
  const style = findCalloutStyle(props?.styleKey, styles);
  if (!style) return { style, ...own, border: "none" };
  return { style, icon: style.icon, color: style.color, border: style.border, title: own.title || style.title };
}

type StyledBlock = { type: string; props?: Record<string, unknown>; children?: StyledBlock[] };

/**
 * Blocks with each styled callout's look written into its own props (icon, color, title), nested
 * ones and those in columns too: for the server's HTML, which draws callouts from their props.
 * The border can't be a prop; withCalloutBorders (server/published-body.ts) adds it to the HTML.
 */
export function applyCalloutStyles<B extends StyledBlock>(blocks: B[], styles: readonly CalloutStyle[]): B[] {
  return blocks.map((block) => {
    const children = block.children?.length ? applyCalloutStyles(block.children as B[], styles) : block.children;
    if (block.type !== CALLOUT_BLOCK || !findCalloutStyle(block.props?.styleKey, styles)) return { ...block, children };
    const { icon, color, title } = resolveCallout(block.props, styles);
    return { ...block, props: { ...block.props, icon, backgroundColor: color, title }, children };
  });
}

/** Props of a new callout of `style`: its key, and its icon and color too, for when the style is gone. */
export function styledCalloutProps(style: CalloutStyle | undefined) {
  return style
    ? { styleKey: style.key, icon: style.icon, backgroundColor: style.color }
    : { styleKey: "", icon: DEFAULT_CALLOUT_ICON, backgroundColor: "gray" };
}

import { readBuiltinIcon } from "./icon-value";
import { defaultProps } from "@blocknote/core";
import { type AlertKind, BREADCRUMB_BLOCK, CALLOUT_BLOCK, DEFAULT_CALLOUT_ICON, FOOTNOTE, INLINE_MATH, MATH_BLOCK, MERMAID_BLOCK, SUBPAGES_BLOCK, TOC_BLOCK } from "./content-block-names";

/**
 * Content blocks beyond BlockNote's own: callouts, equations (block and inline), footnotes, Mermaid
 * diagrams, a table of contents, a breadcrumb and a list of subpages.
 *
 * Like the database blocks (lib/embed-blocks), the configs here are shared by the editor (React
 * specs, components/page/content-blocks.tsx) and the server (plain specs, server/blocknote.ts).
 * Both schemas must know every block: y-prosemirror and the server editor drop nodes they don't
 * know, and a block one side drops is lost for everyone.
 *
 * Sources are kept as the block's text, not as props: an equation or a diagram is edited in the
 * document like a code block, so collaborators' keystrokes merge and search finds the source.
 */

// The names live apart (lib/content-block-names.ts) so code that only needs one skips the editor library.
export { ALERT_KINDS, type AlertKind, BREADCRUMB_BLOCK, CALLOUT_BLOCK, DEFAULT_CALLOUT_ICON, FOOTNOTE, INLINE_MATH, MATH_BLOCK, MERMAID_BLOCK, SUBPAGES_BLOCK, TOC_BLOCK } from "./content-block-names";

/**
 * A callout: an icon and text on a colored background. The color is BlockNote's own background
 * color prop (the block menu's "Colors" changes it); new callouts start gray. One hidden in print
 * shows on screen but is left out of the print view and of whatever the browser prints (BlockNote
 * writes the prop as `data-hide-in-print`), for notes that shouldn't reach a PDF.
 *
 * `styleKey` names one of the workspace's callout styles (lib/callout-styles), whose icon, color,
 * border and default title it is drawn with instead of its own; "" is a plain callout. `title` is
 * a line of plain text above the callout's text, "" for none. Both came later: their defaults are
 * what documents saved before them read as.
 */
export const calloutBlockConfig = {
  type: CALLOUT_BLOCK,
  propSchema: {
    textColor: defaultProps.textColor,
    backgroundColor: defaultProps.backgroundColor,
    icon: { default: DEFAULT_CALLOUT_ICON },
    hideInPrint: { default: false },
    styleKey: { default: "" },
    title: { default: "" },
  },
  content: "inline",
} as const;

/** A display equation: its LaTeX source is the block's text. */
export const mathBlockConfig = { type: MATH_BLOCK, propSchema: {}, content: "plain" } as const;

/** An equation inside a line of text: its LaTeX source is the node's text. */
export const inlineMathConfig = { type: INLINE_MATH, propSchema: {}, content: "plain" } as const;

/**
 * A footnote: a numbered mark in the text whose note is the node's text, so the note travels with
 * the sentence it belongs to (copied, moved or deleted with it). Numbers aren't stored: footnotes
 * count in the order the page has them, and the page lists the notes at its end.
 */
export const footnoteConfig = { type: FOOTNOTE, propSchema: {}, content: "plain" } as const;

/** A Mermaid diagram: its source is the block's text. */
export const mermaidBlockConfig = { type: MERMAID_BLOCK, propSchema: {}, content: "plain" } as const;

/** The page's headings as links. Nothing is stored: the list follows the page. */
export const tocBlockConfig = { type: TOC_BLOCK, propSchema: {}, content: "none" } as const;

/** The page's ancestors as links. Nothing is stored: the path follows the page tree. */
export const breadcrumbBlockConfig = { type: BREADCRUMB_BLOCK, propSchema: {}, content: "none" } as const;

/**
 * The pages directly under the page, as links in the sidebar's order, each reader seeing those they
 * may open. Nothing is stored: the list follows the page tree.
 */
export const subpagesBlockConfig = { type: SUBPAGES_BLOCK, propSchema: {}, content: "none" } as const;

/** KaTeX settings used everywhere: no \href, \url, \includegraphics or \html… (`trust: false`). */
export const KATEX_OPTIONS = {
  trust: false,
  strict: "ignore",
  // Bounds on macro expansion and sizes, so a hostile source can't hang or blow up the page.
  maxExpand: 1000,
  maxSize: 50,
  output: "htmlAndMathml",
} as const;

// ---------------------------------------------------------------------------------------------
// Callout colors in Markdown

/**
 * Callouts are written to Markdown as GitHub alerts, which other apps render too:
 *
 *   > [!NOTE]
 *   > 💡 Text of the callout
 *
 * The alert kind carries the color, as far as the five kinds go: gray, green, purple, yellow and
 * red come back as they were, other colors as the nearest kind's.
 */
const KIND_COLOR: Record<AlertKind, string> = {
  NOTE: "gray",
  TIP: "green",
  IMPORTANT: "purple",
  WARNING: "yellow",
  CAUTION: "red",
};

export function alertKindForColor(color: string): AlertKind {
  switch (color) {
    case "green":
      return "TIP";
    case "purple":
    case "pink":
      return "IMPORTANT";
    case "yellow":
    case "orange":
      return "WARNING";
    case "red":
      return "CAUTION";
    default:
      return "NOTE";
  }
}

export const colorForAlertKind = (kind: AlertKind) => KIND_COLOR[kind];

/** One emoji (with its modifiers and joiners) at the start of `text`, or null. */
export function leadingEmoji(text: string): string | null {
  const match = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|\p{Emoji_Modifier}|‍(?:\p{Extended_Pictographic})️?)*/u.exec(
    text,
  );
  return match ? match[0] : null;
}

/**
 * A callout's icon at the start of its Markdown text: an emoji, or a built-in icon written as it is
 * stored (`icon:star:blue`, lib/icon-value) and followed by a space or nothing.
 */
export function leadingIcon(text: string): string | null {
  const builtin = /^icon:[a-z0-9-]+(?::[a-z]+)?(?=\s|$)/.exec(text);
  if (builtin) return readBuiltinIcon(builtin[0]) ? builtin[0] : null;
  return leadingEmoji(text);
}

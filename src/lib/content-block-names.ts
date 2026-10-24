/**
 * The names of the content blocks (lib/content-blocks.ts) and the alert kinds callouts come from,
 * apart from their configs: code that only needs a name (the workspace's callout styles, loaded on
 * every page) doesn't load the editor library with them.
 */

export const CALLOUT_BLOCK = "callout";
export const MATH_BLOCK = "math";
export const INLINE_MATH = "inlineMath";
export const FOOTNOTE = "footnote";
export const MERMAID_BLOCK = "mermaid";
export const TOC_BLOCK = "tableOfContents";
export const BREADCRUMB_BLOCK = "breadcrumb";
export const SUBPAGES_BLOCK = "subpages";

export const DEFAULT_CALLOUT_ICON = "💡";

/** The alert kinds of Markdown (`> [!NOTE]`), which become callouts. */
export const ALERT_KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

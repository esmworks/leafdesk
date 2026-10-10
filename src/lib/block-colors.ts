/**
 * The page editor's block colors, in the formatting toolbar's order: "default" and the option
 * palette's hues (see the `--bn-colors-highlights-*` variables in globals.css). Pure and client-safe.
 */
export const BLOCK_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export type BlockColor = (typeof BLOCK_COLORS)[number];

/**
 * What a slash menu color entry is found by besides its title: the color's English name, its name
 * in the interface language and the words for text or background, lowercased, once each.
 */
export function colorAliases(color: BlockColor, localName: string, words: string[]): string[] {
  const all = [color, localName, ...words].map((word) => word.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}

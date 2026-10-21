/**
 * A page body cut into slides for presenting it (components/page/presentation.tsx). Only the
 * page's top-level blocks start slides; a block's nested children, and whatever sits inside
 * columns or toggles, stay with it.
 *
 * A page with dividers is cut at each divider, and the dividers themselves aren't shown. A page
 * without them is cut before each heading of level 1 or 2, which opens its slide. What comes
 * before the first cut is a slide of its own. Slides holding nothing but empty paragraphs are
 * left out, so the editor's trailing empty paragraph or two dividers in a row add no blank slide.
 * The title slide (the page's icon and title) isn't part of this: the presentation adds it.
 */

/** As much of a BlockNote block as the cut needs. */
export type SlideBlock = {
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly unknown[];
};

/** Headings of these levels open a slide on a page without dividers. */
const SLIDE_HEADING_LEVELS = new Set([1, 2]);

export function splitSlides<T extends SlideBlock>(blocks: readonly T[]): T[][] {
  const byDividers = blocks.some((block) => block.type === "divider");
  const slides: T[][] = [];
  let current: T[] = [];
  const cut = () => {
    if (current.some((block) => !isEmptyParagraph(block))) slides.push(current);
    current = [];
  };
  for (const block of blocks) {
    if (byDividers) {
      if (block.type === "divider") {
        cut();
        continue;
      }
    } else if (block.type === "heading" && SLIDE_HEADING_LEVELS.has(Number(block.props?.level ?? 1))) {
      cut();
    }
    current.push(block);
  }
  cut();
  return slides;
}

function isEmptyParagraph(block: SlideBlock): boolean {
  if (block.type !== "paragraph" || block.children?.length) return false;
  const content = block.content;
  if (content == null) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  return content.every((item) => item && typeof item === "object" && (item as { type?: string }).type === "text" && !String((item as { text?: unknown }).text ?? "").trim());
}

/**
 * A code block's caption (lib/code-block) as text and in Markdown, import-free for
 * lib/content-markdown and the editor.
 */

/** Longest caption a code block keeps. */
export const MAX_CODE_CAPTION = 500;

/** A caption as one line of at most MAX_CODE_CAPTION characters. */
export const cleanCodeCaption = (caption: string) => caption.replace(/\s+/g, " ").trim().slice(0, MAX_CODE_CAPTION);

/** The Markdown line before a code block with this caption. `-->` would end the comment, so it is written `--\>`. */
export function codeCaptionLine(caption: string): string {
  return `<!-- leafdesk:caption ${cleanCodeCaption(caption).replaceAll("-->", "--\\>")} -->`;
}

const CAPTION_LINE = /^ {0,3}<!--\s*leafdesk:caption (.*?)\s*-->\s*$/;

/** The caption a Markdown line gives the code block after it, or null for any other line. */
export function readCodeCaptionLine(line: string): string | null {
  const match = CAPTION_LINE.exec(line);
  return match ? cleanCodeCaption(match[1].replaceAll("--\\>", "-->")) || null : null;
}

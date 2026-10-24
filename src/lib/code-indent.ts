/**
 * Enter in a code block (components/page/code-block.tsx): the new line starts with the indentation
 * of the line the cursor was on, as code editors do. Pure, over the block's text.
 */

/** What Enter writes: `insert` in place of the text from `from` to `to` (offsets in the block's text). */
export type CodeLineBreak = { from: number; to: number; insert: string };

/**
 * What Enter does with the selection from `from` to `to` in a code block holding `text`, or null
 * when the block's own Enter should run: the line has no indentation to keep. An indented line
 * holding nothing yet, at the end of the block, gives its indentation up: the block then ends in
 * an empty line, and the next Enter leaves the block as it does without indentation.
 */
export function codeLineBreak(text: string, from: number, to: number = from): CodeLineBreak | null {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const before = text.slice(lineStart, from);
  const indent = /^[ \t]*/.exec(before)![0];
  if (!indent) return null;
  if (before === indent && to === text.length) return { from: lineStart, to, insert: "\n" };
  return { from, to, insert: `\n${indent}` };
}

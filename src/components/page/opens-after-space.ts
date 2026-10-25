import type { Transaction } from "prosemirror-state";

/**
 * For a suggestion menu's `shouldOpen`: only at the start of a line or after a space, so a trigger
 * typed after a word (a semicolon, `C++`) is just that character.
 */
export function opensAfterSpace(tr: Transaction) {
  const { $from } = tr.selection;
  if ($from.parentOffset === 0) return true;
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, "￼");
  return /\s/.test(before);
}

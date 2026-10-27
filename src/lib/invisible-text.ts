/**
 * Characters that show nothing on screen but reach a model as text: Unicode tag characters
 * (U+E0000–E007F, which spell out ASCII no one sees), zero-width space and word joiners, direction
 * marks and overrides, the byte order mark and soft hyphens. Text hidden in them on a web page, in
 * an email or a row can carry instructions a person reading the same text never sees. Zero-width
 * joiners and non-joiners (U+200C, U+200D) stay: Persian and other scripts and emoji sequences
 * need them.
 */
const INVISIBLE = /[­᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

/** `text` without the characters that show nothing (see INVISIBLE). */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

import { linkedPageRef } from "./mentions";

/** Links to pages of this app pasted together: what each points at, and whether they came one per line. */
export type PastedPageLinks = { refs: { pageId: string; blockId: string }[]; lines: boolean };

/**
 * Text pasted into a page that is nothing but links to pages of this app (`appUrl`), one or more,
 * separated by spaces or line breaks (a list copied with "Copy links"), or null for anything else.
 * Bullets or numbers before links on their own lines ("- ", "1. ") are let through too.
 */
export function pastedPageLinks(text: string, appUrl: string): PastedPageLinks | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""))
    .filter(Boolean);
  const words = lines.flatMap((line) => line.split(/\s+/));
  if (!words.length) return null;
  const refs = words.map((word) => linkedPageRef(word, appUrl));
  if (refs.some((ref) => !ref)) return null;
  return { refs: refs as PastedPageLinks["refs"], lines: lines.length > 1 };
}

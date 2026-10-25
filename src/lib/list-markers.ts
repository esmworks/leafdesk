/**
 * Numbered lists count in a different style at each level they are nested in: 1, 2, 3 at the top,
 * a, b, c one level in, i, ii, iii the next, then numbers again. Shared by the editor
 * (components/page/list-markers.ts), published pages (CSS on nested <ol>) and server-made PDFs.
 */

export type ListStyle = "decimal" | "lower-alpha" | "lower-roman";

const STYLES: readonly ListStyle[] = ["decimal", "lower-alpha", "lower-roman"];

/** The style of a numbered list nested in `depth` numbered lists (0 at the top). */
export function listStyleAt(depth: number): ListStyle {
  return STYLES[((depth % STYLES.length) + STYLES.length) % STYLES.length];
}

/** 1 → a, 26 → z, 27 → aa, as spreadsheets name columns. */
function alpha(n: number): string {
  let out = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
  return out;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function roman(n: number): string {
  let out = "";
  let rest = n;
  for (const [value, letters] of ROMAN) {
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  }
  return out;
}

/** The marker of item `index` (1-based) of a list in `style`; numbers where letters can't say it. */
export function listMarker(index: number, style: ListStyle): string {
  if (!Number.isInteger(index) || index < 1 || style === "decimal") return String(index);
  if (style === "lower-alpha") return alpha(index);
  return index < 4000 ? roman(index) : String(index);
}

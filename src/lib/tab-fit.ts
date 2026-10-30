/**
 * Which tabs of a row fit in `room` pixels, given their `widths` in order and the `gap` after each.
 * Returns null when all of them fit. Otherwise a button listing the rest, `more` pixels wide, ends
 * the row: the tab at `keep` (the open one, -1 for none) always shows, in its place, and the others
 * show in order until one doesn't fit.
 */
export function fitTabs(widths: number[], keep: number, room: number, gap: number, more: number): number[] | null {
  const all = widths.reduce((sum, width) => sum + width + gap, -gap);
  if (all <= room) return null;
  let used = more + (keep >= 0 ? widths[keep] + gap : 0);
  let full = false;
  const shown: number[] = [];
  widths.forEach((width, i) => {
    if (i === keep) shown.push(i);
    else if (!full && used + width + gap <= room) {
      used += width + gap;
      shown.push(i);
    } else full = true;
  });
  return shown;
}

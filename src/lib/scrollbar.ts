/**
 * Geometry of a drawn horizontal scrollbar that mirrors a scrolling box.
 *
 * scrollLeft runs 0 → max left to right, and 0 → -max in a right-to-left box (its start is on the
 * right). The thumb's offset is always measured from the track's left edge.
 */

export interface ScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  rtl: boolean;
}

/** Thinner than this and the thumb is hard to grab on a very wide board. */
export const MIN_THUMB = 32;

/** How far the box scrolls sideways; under a pixel counts as not overflowing. */
export function scrollRange({ scrollWidth, clientWidth }: Pick<ScrollMetrics, "scrollWidth" | "clientWidth">): number {
  const range = scrollWidth - clientWidth;
  return range > 1 ? range : 0;
}

export function thumbGeometry(m: ScrollMetrics, track: number): { size: number; offset: number } | null {
  const range = scrollRange(m);
  if (range === 0 || track <= 0) return null;
  const size = Math.min(track, Math.max(MIN_THUMB, (track * m.clientWidth) / m.scrollWidth));
  const fromLeft = m.rtl ? m.scrollLeft + range : m.scrollLeft;
  const fraction = Math.min(1, Math.max(0, fromLeft / range));
  return { size, offset: fraction * (track - size) };
}

/** The box's scrollLeft once the thumb has moved dx pixels from where a drag started. */
export function scrollLeftForDrag(start: number, dx: number, m: Omit<ScrollMetrics, "scrollLeft">, track: number, size: number): number {
  const range = scrollRange(m);
  const free = track - size;
  if (range === 0 || free <= 0) return start;
  const next = start + (dx * range) / free;
  return m.rtl ? Math.min(0, Math.max(-range, next)) : Math.min(range, Math.max(0, next));
}

/** The box's scrollLeft that centres the thumb on a point x pixels from the track's left edge. */
export function scrollLeftForTrackPoint(x: number, m: Omit<ScrollMetrics, "scrollLeft">, track: number, size: number): number {
  const range = scrollRange(m);
  const free = track - size;
  if (range === 0 || free <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, (x - size / 2) / free));
  return m.rtl ? fraction * range - range : fraction * range;
}

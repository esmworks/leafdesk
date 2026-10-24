/**
 * Swiping an inbox item on a touch screen (components/sidebar/inbox-swipe.tsx): toward the end of
 * the line (right, or left when right to left) marks it read or unread, toward its start snoozes
 * it. Pure, in screen pixels: `dx` is how far the finger moved sideways, right positive.
 */

/** How far a swipe goes before letting go does something. */
export const SWIPE_COMMIT_PX = 72;
/** The farthest the item follows the finger. */
export const SWIPE_MAX_PX = 112;
/** How far the finger moves before it is known to be a swipe or a scroll. */
export const SWIPE_SLOP_PX = 8;

export type SwipeAction = "read" | "snooze";

/** "x" for a swipe, "y" for a scroll of the list, null while too short to tell. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Which way the swipe goes, read the way the line runs: 1 toward its end, -1 toward its start. */
const forward = (dx: number, rtl: boolean) => (rtl ? -dx : dx);

/** What the swipe would do if let go now. */
export function swipeActionFor(dx: number, rtl: boolean, snoozable: boolean): SwipeAction | null {
  const along = forward(dx, rtl);
  if (along >= SWIPE_COMMIT_PX) return "read";
  if (along <= -SWIPE_COMMIT_PX && snoozable) return "snooze";
  return null;
}

/** Which hint shows behind the item while it is swiped, if any. */
export function swipeSide(dx: number, rtl: boolean, snoozable: boolean): SwipeAction | null {
  const along = forward(dx, rtl);
  if (along > 0) return "read";
  if (along < 0 && snoozable) return "snooze";
  return null;
}

/**
 * Where the item is drawn: following the finger up to SWIPE_MAX_PX, and only a little the way that
 * does nothing (an item that can't be snoozed).
 */
export function swipeOffset(dx: number, rtl: boolean, snoozable: boolean): number {
  const along = forward(dx, rtl);
  const shown = along < 0 && !snoozable ? Math.max(along / 4, -16) : Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, along));
  return rtl ? -shown : shown;
}

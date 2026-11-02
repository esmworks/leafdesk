"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** Whether this browser can drive animations by a box's scroll (ScrollTimeline); false on the server. */
export function useScrollTimelines() {
  return useSyncExternalStore(noSubscription, () => typeof ScrollTimeline === "function", () => false);
}

const shift = (x: number, offset?: number) => ({ transform: `translateX(${x}px)`, ...(offset === undefined ? {} : { offset }) });
const rangeOf = (el: HTMLElement) => Math.max(0, el.scrollWidth - el.clientWidth);

/**
 * Moves a table's header row sideways with its rows in the same frame. Following the rows' scroll
 * events moves it a frame or more late, after the rows have been drawn where they scrolled to, so
 * the column names wobble against their columns. Animations driven by the rows' scroll are drawn
 * together with it.
 *
 * `head` is the header's own scrolling box, still kept at the rows' scroll so the header can be
 * scrolled and focused in; `wrapper`, inside it, takes that scroll back out, and `table`, inside
 * the wrapper, takes the rows'. `frozen` are the header's frozen cells, which stay put, unstuck,
 * once the rows have scrolled past `holdAt`, where the rows' frozen cells stick.
 */
export function followRowsByTimeline(rows: HTMLElement, head: HTMLElement, wrapper: HTMLElement, table: HTMLElement, frozen: HTMLElement[], holdAt: number) {
  // Scrolling toward the inline end moves content left, right to left rightward.
  const toEnd = getComputedStyle(rows).direction === "rtl" ? 1 : -1;
  let animations: Animation[] = [];
  let ranges = "";
  const build = () => {
    const range = rangeOf(rows);
    const own = rangeOf(head);
    if (`${range} ${own}` === ranges) return;
    ranges = `${range} ${own}`;
    for (const animation of animations) animation.cancel();
    animations = [];
    const by = (source: HTMLElement): KeyframeAnimationOptions => ({ timeline: new ScrollTimeline({ source, axis: "inline" }), fill: "both" });
    if (own > 0) animations.push(wrapper.animate([shift(0), shift(-toEnd * own)], by(head)));
    if (range === 0) return;
    animations.push(table.animate([shift(0), shift(toEnd * range)], by(rows)));
    const held = (scrolled: number) => -toEnd * Math.max(0, scrolled - holdAt);
    const keyframes = [shift(held(0), 0), ...(holdAt > 0 && holdAt < range ? [shift(0, holdAt / range)] : []), shift(held(range), 1)];
    for (const cell of frozen) animations.push(cell.animate(keyframes, by(rows)));
  };
  build();
  // Widths change with columns, the window and the room kept for the row panel, which no resize
  // reports: a scroll checks too, before the next one is drawn.
  const observer = new ResizeObserver(build);
  for (const el of [rows, head, table]) observer.observe(el);
  rows.addEventListener("scroll", build, { passive: true });
  return () => {
    observer.disconnect();
    rows.removeEventListener("scroll", build);
    for (const animation of animations) animation.cancel();
  };
}

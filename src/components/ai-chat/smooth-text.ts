"use client";

import { useEffect, useRef, useState } from "react";

/** The fewest letters a second shown while an answer is being written. */
const BASE_RATE = 90;
/**
 * The longest a piece of text is spread over, and so the most the text shown keeps behind what
 * came; also the longest the rest takes to show once the answer is written.
 */
const MAX_SPREAD_MS = 1_000;
/** How much the latest wait between two pieces weighs in their average. */
const GAP_WEIGHT = 0.3;
/** A frame that comes later than this (a tab in the background) counts as this long. */
const MAX_FRAME_MS = 100;

/**
 * How an answer's text is shown: how many letters (with the fraction of one a frame carried to the
 * next), at how many letters a millisecond, and how far apart its pieces have come (averaged; null
 * before a second one came) and when the last one came (null before the first).
 */
export type Pace = { shown: number; speed: number; gap: number | null; came: number | null };

export const startPace = (shown = 0): Pace => ({ shown, speed: 0, gap: null, came: null });

/**
 * More text came at `now`, `length` letters in all: what isn't shown yet is spread over the time
 * pieces have come apart, so it shows at an even pace until the next one is due rather than at once
 * and then waiting. The first piece is spread over the longest time: it may be a whole answer.
 */
export function textCame(pace: Pace, length: number, now: number): Pace {
  const waited = pace.came === null ? null : Math.min(now - pace.came, MAX_SPREAD_MS);
  const gap = waited === null ? pace.gap : pace.gap === null ? waited : pace.gap + GAP_WEIGHT * (waited - pace.gap);
  const spread = Math.min(Math.max(gap ?? MAX_SPREAD_MS, 1), MAX_SPREAD_MS);
  return { ...pace, gap, came: now, speed: Math.max(BASE_RATE / 1000, (length - pace.shown) / spread) };
}

/**
 * A frame `elapsed` ms after the one before, of a text `length` letters long: its pace goes on.
 * Once the answer is no longer `writing`, no piece is due any more: the rest shows within
 * MAX_SPREAD_MS, no slower than it went.
 */
export function advance(pace: Pace, length: number, writing: boolean, elapsed: number): Pace {
  const left = length - pace.shown;
  if (left <= 0) return { ...pace, shown: length };
  const speed = writing ? pace.speed : Math.max(pace.speed, left / MAX_SPREAD_MS);
  return { ...pace, speed, shown: Math.min(length, pace.shown + Math.max(speed, BASE_RATE / 1000) * Math.min(elapsed, MAX_FRAME_MS)) };
}

/** Where a text shown `shown` letters far ends: at a whole letter, never between the two halves of an emoji. */
export function shownEnd(text: string, shown: number): number {
  let end = Math.min(text.length, Math.floor(shown));
  if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end += 1;
  return end;
}

/**
 * The part of an answer's `text` to show now. The network brings an answer in pieces: from one
 * model a few letters at a time, from another a sentence or a paragraph a second, often several at
 * once after a pause. While `writing`, each frame shows a few more letters at the pace the pieces
 * come (textCame), so the text flows evenly, letter by letter, up to a second behind what came,
 * instead of jumping a piece at a time; once written, the rest goes on flowing (advance), never
 * shown in one frame, which would grow the answer by lines at once and make the page jump. An
 * answer shown when it is no longer being written is shown whole; one replaced while written (a
 * turn's text that was the model thinking aloud) starts over. Frames run only while there is
 * something to show.
 */
export function useSmoothText(text: string, writing: boolean): string {
  const [shown, setShown] = useState(writing ? "" : text);
  // What the frames read: the latest text and whether it is still written, what they showed, how,
  // and how long the text was when it last grew.
  const now = useRef({ text, writing, shown, pace: startPace(shown.length), length: shown.length });
  now.current.text = text;
  now.current.writing = writing;
  const frame = useRef(0);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  useEffect(() => {
    const state = now.current;
    if (!text.startsWith(state.shown)) {
      state.shown = writing ? "" : text;
      state.pace = { ...startPace(state.shown.length), gap: state.pace.gap };
      state.length = state.shown.length;
      setShown(state.shown);
    }
    if (text.length > state.length) {
      state.pace = textCame(state.pace, text.length, performance.now());
      state.length = text.length;
    }
    if (state.shown.length >= text.length || frame.current) return;
    let last = performance.now();
    const step = (time: number) => {
      const { text: full, writing: going, shown: was } = now.current;
      if (was.length >= full.length) {
        frame.current = 0;
        return;
      }
      const pace = advance(state.pace, full.length, going, time - last);
      const end = Math.max(was.length, shownEnd(full, pace.shown));
      // An emoji's second half shown with its first counts as shown.
      state.pace = { ...pace, shown: Math.max(pace.shown, end) };
      last = time;
      if (end > was.length) {
        state.shown = full.slice(0, end);
        setShown(state.shown);
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [text, writing]);

  return shown;
}

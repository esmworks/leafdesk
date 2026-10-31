"use client";

import { useEffect, useRef, useState } from "react";

/** The fewest letters a second shown while an answer is being written. */
const BASE_RATE = 90;
/** While it is written, each frame shows at least this many-th of the backlog. */
const CATCH_UP_FRAMES = 9;
/** Once written, each frame shows at least this many-th of what is left. */
const DRAIN_FRAMES = 4;

/**
 * What a frame shows of `text` after `shown`, `elapsed` ms after the frame before: while `writing`,
 * at least BASE_RATE letters a second and a CATCH_UP_FRAMES-th of the backlog; after, a
 * DRAIN_FRAMES-th of what is left.
 */
export function nextShown(text: string, shown: string, writing: boolean, elapsed: number): string {
  const backlog = text.length - shown.length;
  if (backlog <= 0) return text;
  const letters = writing
    ? Math.max(1, Math.ceil((Math.min(elapsed, 100) / 1000) * BASE_RATE), Math.ceil(backlog / CATCH_UP_FRAMES))
    : Math.ceil(backlog / DRAIN_FRAMES);
  let end = Math.min(text.length, shown.length + letters);
  // Never between the two halves of an emoji.
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end += 1;
  return text.slice(0, end);
}

/**
 * The part of an answer's `text` to show now. The network brings an answer in pieces, often
 * several at once after a pause; while `writing`, each frame shows a few more letters, so the text
 * flows at an even pace instead of jumping a piece at a time: at least BASE_RATE letters a second,
 * faster as a backlog builds, so it keeps a fraction of a second behind what came. Once written, the rest is shown over a few frames: shown in one, the answer would grow by
 * lines at once and the page jump. An answer shown when it is no longer being written is shown
 * whole; one replaced while written (a turn's text that was the model thinking aloud) starts over.
 * Frames run only while there is something to show.
 */
export function useSmoothText(text: string, writing: boolean): string {
  const [shown, setShown] = useState(writing ? "" : text);
  // What the frames read: the latest text and whether it is still written, and what they showed.
  const now = useRef({ text, writing, shown });
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
      setShown(state.shown);
    }
    if (state.shown.length >= text.length || frame.current) return;
    let last = performance.now();
    const step = (time: number) => {
      const { text: full, writing: going, shown: was } = now.current;
      const backlog = full.length - was.length;
      if (backlog <= 0) {
        frame.current = 0;
        return;
      }
      state.shown = nextShown(full, was, going, time - last);
      last = time;
      setShown(state.shown);
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [text, writing]);

  return shown;
}

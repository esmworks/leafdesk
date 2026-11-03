import { describe, expect, it } from "vitest";
import { advance, shownEnd, startPace, textCame, type Pace } from "./smooth-text";

const FRAME = 1000 / 60;

/**
 * Plays a text that comes in pieces (`pieces`: [ms after the start, letters added]) at 60 frames a
 * second, written until the last piece came (or `writtenUntil`): how many letters each frame
 * showed, and when all of it was shown.
 */
function play(pieces: [number, number][], { writtenUntil = pieces.at(-1)![0], until = 20_000 } = {}) {
  let pace: Pace = startPace();
  let length = 0;
  let next = 0;
  const frames: { t: number; added: number; shown: number; length: number }[] = [];
  for (let t = 0; t < until; t += FRAME) {
    while (next < pieces.length && pieces[next][0] <= t) {
      length += pieces[next][1];
      pace = textCame(pace, length, t);
      next += 1;
    }
    const before = Math.floor(pace.shown);
    pace = advance(pace, length, t <= writtenUntil, FRAME);
    frames.push({ t, added: Math.floor(pace.shown) - before, shown: Math.floor(pace.shown), length });
    if (next === pieces.length && pace.shown >= length) break;
  }
  return { frames, end: frames.at(-1)!.t };
}

/** Pieces of `size` letters every `every` ms, `count` of them, the first at `from`. */
const steady = (count: number, size: number, every: number, from = 0) => Array.from({ length: count }, (_, i) => [from + i * every, size] as [number, number]);

describe("smooth text", () => {
  it("spreads big pieces over the time until the next instead of showing each at once", () => {
    // A paragraph-sized piece a second, as some models send them: about six letters a frame,
    // every frame, rather than the whole piece in a few frames and then a pause.
    const { frames } = play(steady(10, 350, 1000));
    const middle = frames.filter((f) => f.t > 2_100 && f.t < 8_900);
    expect(Math.max(...middle.map((f) => f.added))).toBeLessThanOrEqual(12);
    // Hardly a frame without letters while there is more to come.
    expect(middle.filter((f) => f.added === 0).length).toBeLessThan(middle.length / 10);
  });

  it("keeps up with a fast model, a few letters at a time", () => {
    // 1,000 letters a second, in pieces of 20: never more than a second behind, and done soon after.
    const pieces = steady(100, 20, 20, 0);
    const { frames, end } = play(pieces);
    const behind = Math.max(...frames.map((f) => f.length - f.shown));
    expect(behind).toBeLessThan(1_000);
    expect(end).toBeLessThan(pieces.at(-1)![0] + 1_100);
    expect(Math.max(...frames.map((f) => f.added))).toBeLessThan(60);
  });

  it("shows an answer that came whole over about a second, not in one frame", () => {
    const { frames, end } = play([[0, 2_000]]);
    expect(frames[0].added).toBeLessThan(100);
    expect(end).toBeGreaterThan(700);
    expect(end).toBeLessThan(1_200);
  });

  it("shows the rest within a second once written, without slowing down", () => {
    // Written while 600 letters are still to show: they go on at least as fast as before.
    const { frames, end } = play([...steady(4, 50, 200), [800, 600]], { writtenUntil: 800 });
    const last = frames.findLast((f) => f.added > 0)!;
    expect(end - 800).toBeLessThanOrEqual(1_050);
    expect(last.shown).toBe(800);
  });

  it("shows at least a few letters a frame, and no more for a frame that came late", () => {
    let pace = textCame(startPace(), 40, 0);
    pace = advance(pace, 40, true, 5_000);
    // A frame late by seconds counts as 100 ms.
    expect(pace.shown).toBeLessThanOrEqual(10);
    expect(pace.shown).toBeGreaterThan(0);
  });

  it("shows what is there and no more", () => {
    expect(advance({ ...startPace(3), speed: 1 }, 3, true, FRAME).shown).toBe(3);
    expect(advance(textCame(startPace(2), 3, 0), 3, false, FRAME).shown).toBeLessThanOrEqual(3);
  });

  it("never ends between the two halves of an emoji", () => {
    const text = "a😀b";
    expect(shownEnd(text, 1)).toBe(1);
    expect(shownEnd(text, 2)).toBe(3);
    expect(shownEnd(text, 2.5)).toBe(3);
    expect(shownEnd(text, 10)).toBe(4);
  });
});

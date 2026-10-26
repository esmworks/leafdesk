import { expect } from "vitest";

/**
 * For tests that readers of imported files take time growing with the file's length: crafted
 * files (long runs of spaces, brackets, dashes…) used to keep the server busy for minutes.
 */

/** Runs `fn` and expects it done within `ms` (inputs are made large enough that quadratic time takes far longer). */
export function fast<T>(fn: () => T, ms = 500): T {
  const started = performance.now();
  const result = fn();
  expect(performance.now() - started).toBeLessThan(ms);
  return result;
}

/**
 * `count` texts of up to `length` characters drawn from `pieces`, the same every run: for checking
 * a reader written by hand against the regex it stands for.
 */
export function randomTexts(pieces: string[], count = 3000, length = 12): string[] {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, () => {
    let text = "";
    const parts = Math.floor(next() * length);
    for (let i = 0; i < parts; i++) text += pieces[Math.floor(next() * pieces.length)];
    return text;
  });
}

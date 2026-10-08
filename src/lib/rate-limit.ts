/**
 * Sliding-window rate limiting in memory: at most `limit` hits per key within any `windowMs`.
 * State lives in this process, which is enough for a single-node app; limits start over when the
 * server restarts, and several nodes would each count on their own.
 */
export class SlidingWindowLimiter {
  /** Hit times per key, oldest first. */
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Keys kept at most; the least recently hit ones are forgotten first. */
    readonly maxKeys = 10_000,
  ) {}

  private recent(key: string, now: number) {
    const times = this.hits.get(key);
    if (!times) return [];
    const from = now - this.windowMs;
    let i = 0;
    while (i < times.length && times[i] <= from) i++;
    if (i) times.splice(0, i);
    if (!times.length) this.hits.delete(key);
    return times;
  }

  /** How long until `key` may be hit again: 0 when it may be now. */
  retryAfter(key: string, now = Date.now()): number {
    const times = this.recent(key, now);
    if (times.length < this.limit) return 0;
    return times[times.length - this.limit] + this.windowMs - now;
  }

  /** Hits of `key` within the window ending now. */
  count(key: string, now = Date.now()): number {
    return this.recent(key, now).length;
  }

  hit(key: string, now = Date.now()) {
    const times = this.recent(key, now);
    times.push(now);
    // Re-inserting keeps the Map in order of last hit, so the oldest keys come first below.
    this.hits.delete(key);
    this.hits.set(key, times);
    for (const old of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(old);
    }
  }

  reset() {
    this.hits.clear();
  }
}

/**
 * Takes one hit from each limiter when all of them allow it, else none. Returns how long to wait
 * (0 when the hits were taken), so a blocked request doesn't use up the other limits.
 */
export function takeAll(entries: [SlidingWindowLimiter, string][], now = Date.now()): number {
  const wait = Math.max(0, ...entries.map(([limiter, key]) => limiter.retryAfter(key, now)));
  if (wait > 0) return wait;
  for (const [limiter, key] of entries) limiter.hit(key, now);
  return 0;
}

/** A limit set in an environment variable: a whole number, 0 turning it off; else `fallback`. */
export function limitFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const SHARED = "__leafdeskLimiters";

/**
 * A limiter kept on `globalThis` under `name`, so every bundle that imports this module (Next
 * builds route handlers and server actions separately) counts against the same hits.
 */
export function sharedLimiter(name: string, limit: number, windowMs: number): SlidingWindowLimiter {
  const holder = globalThis as Record<string, unknown>;
  const all = (holder[SHARED] ??= new Map<string, SlidingWindowLimiter>()) as Map<string, SlidingWindowLimiter>;
  let limiter = all.get(name);
  if (!limiter || limiter.limit !== limit || limiter.windowMs !== windowMs) {
    limiter = new SlidingWindowLimiter(limit, windowMs);
    all.set(name, limiter);
  }
  return limiter;
}

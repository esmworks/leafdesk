import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, takeAll } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows `limit` hits per window and says when the next one is allowed", () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    for (const t of [0, 100, 200]) {
      expect(limiter.retryAfter("ip", t)).toBe(0);
      limiter.hit("ip", t);
    }
    expect(limiter.retryAfter("ip", 300)).toBe(700);
    // The window slides: the first hit drops out after a second.
    expect(limiter.retryAfter("ip", 1000)).toBe(0);
    limiter.hit("ip", 1000);
    expect(limiter.retryAfter("ip", 1050)).toBe(50);
  });

  it("says when a key gets one more hit back", () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    expect(limiter.resetAt("ip", 50)).toBe(50);
    limiter.hit("ip", 100);
    limiter.hit("ip", 400);
    expect(limiter.resetAt("ip", 500)).toBe(1100);
    // Once the oldest hit has left the window, the next one counts.
    expect(limiter.resetAt("ip", 1200)).toBe(1400);
  });

  it("counts keys separately", () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    limiter.hit("a", 0);
    expect(limiter.retryAfter("a", 10)).toBeGreaterThan(0);
    expect(limiter.retryAfter("b", 10)).toBe(0);
  });

  it("forgets the least recently hit keys beyond maxKeys", () => {
    const limiter = new SlidingWindowLimiter(1, 1000, 2);
    limiter.hit("a", 0);
    limiter.hit("b", 1);
    limiter.hit("a", 2); // a is blocked, but it was hit last
    limiter.hit("c", 3);
    expect(limiter.retryAfter("b", 4)).toBe(0);
    expect(limiter.retryAfter("a", 4)).toBeGreaterThan(0);
  });

  it("starts over after reset", () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    limiter.hit("a", 0);
    limiter.reset();
    expect(limiter.retryAfter("a", 1)).toBe(0);
  });
});

describe("takeAll", () => {
  it("takes a hit from every limiter only when all allow it", () => {
    const perIp = new SlidingWindowLimiter(5, 1000);
    const perForm = new SlidingWindowLimiter(1, 1000);
    expect(takeAll([[perIp, "ip"], [perForm, "form"]], 0)).toBe(0);
    expect(takeAll([[perIp, "ip"], [perForm, "form"]], 10)).toBe(990);
    // The blocked request didn't use up the per-IP allowance: four more fit.
    for (let i = 0; i < 4; i++) expect(takeAll([[perIp, "ip"], [perForm, `other${i}`]], 20)).toBe(0);
    expect(takeAll([[perIp, "ip"], [perForm, "other9"]], 20)).toBe(980);
  });
});

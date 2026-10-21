import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HANDOFF_WAIT_MS } from "@/lib/agents";
import { runClock } from "./clock";

describe("a run's clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs out after the run's own time", () => {
    const clock = runClock(1_000);
    vi.advanceTimersByTime(999);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(clock.signal.aborted).toBe(true);
    expect((clock.signal.reason as DOMException).name).toBe("TimeoutError");
    expect(clock.waitLeft()).toBe(0);
  });

  it("stands still while the run waits for the agents it asks", () => {
    const clock = runClock(1_000);
    vi.advanceTimersByTime(400);
    expect(clock.waitLeft()).toBe(MAX_HANDOFF_WAIT_MS);
    clock.pause();
    vi.advanceTimersByTime(60_000);
    clock.resume();
    expect(clock.signal.aborted).toBe(false);
    // The run keeps the 600 ms it had; the wait used a minute of what it may wait.
    expect(clock.waitLeft()).toBe(MAX_HANDOFF_WAIT_MS - 60_000);
    vi.advanceTimersByTime(599);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(clock.signal.aborted).toBe(true);
  });

  it("never lasts past its own time and the most it may wait", () => {
    const clock = runClock(1_000);
    vi.advanceTimersByTime(500);
    clock.pause();
    vi.advanceTimersByTime(MAX_HANDOFF_WAIT_MS + 10_000);
    clock.resume();
    expect(clock.waitLeft()).toBe(0);
    // A wait longer than allowed eats into the run's own time: past the cap, it runs out at once.
    vi.advanceTimersByTime(0);
    expect(clock.signal.aborted).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { lastActivity, newThreadIds } from "./thread-activity";

const t = (minute: number) => new Date(Date.UTC(2026, 9, 23, 12, minute)).toISOString();
const c = (userId: string, minute: number, deleted = false) => ({ userId, createdAt: t(minute), deletedAt: deleted ? t(minute + 1) : null });

describe("lastActivity", () => {
  it("is the newest comment's time", () => {
    expect(lastActivity({ id: "a", createdAt: t(0), comments: [c("ann", 0), c("bob", 9), c("cy", 4)] })).toBe(Date.parse(t(9)));
  });
});

describe("newThreadIds", () => {
  const threads = [
    { id: "replied", createdAt: t(0), comments: [c("me", 0), c("bob", 10)] },
    { id: "quiet", createdAt: t(0), comments: [c("bob", 1)] },
    { id: "started", createdAt: t(20), comments: [c("bob", 20)] },
    { id: "mine", createdAt: t(0), comments: [c("bob", 2), c("me", 30)] },
    { id: "deleted", createdAt: t(0), comments: [c("bob", 25, true)] },
  ];

  it("tells threads with others' comments since last seen", () => {
    const seen = { replied: t(5), quiet: t(5), mine: t(1), deleted: t(5) };
    expect([...newThreadIds(threads, "me", seen)].sort()).toEqual(["replied", "started"]);
  });

  it("counts threads never seen from the last look at the page's comments", () => {
    expect([...newThreadIds(threads, "me", { replied: t(15) })].sort()).toEqual(["started"]);
  });

  it("has nothing new for someone who never looked", () => {
    expect(newThreadIds(threads, "me", {}).size).toBe(0);
  });
});
